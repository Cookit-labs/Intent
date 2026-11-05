import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import type { LimitBook, RestingOrder } from '../limit'
import {
  ChainActionRefused,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
} from '../types'
import { buildUnsigned, suiClient, withTimeout } from './client'
import {
  addExit,
  addPlace,
  decodeIds,
  decodeManager,
  decodeOrderId,
  decodeOrders,
  decodeSettled,
  deepbookAssertSafe,
  deepbookPair,
  DEEPBOOK_READS,
  orderFigures,
  quoteOf,
  type BookOrder,
  type ManagerRef,
  type PoolBook,
} from './deepbook-rules'
import {
  DEEPBOOK_MANAGER_TYPE,
  DEEPBOOK_POOL,
  DEEPBOOK_POOL_VERSION,
  DEEPBOOK_REGISTRY,
  DEEPBOOK_REGISTRY_VERSION,
  DEEPBOOK_SUI,
  DEEPBOOK_USDC,
} from './policies'
import { displayAmount } from './tokens'

/**
 * What simulating on mainnet settled on 5 November 2026, for a public funded wallet and with nothing
 * signed (`sui-deepbook.live.test.ts`):
 *
 * 1. `new`, `deposit`, `generate_proof_as_owner`, `place_limit_order` and `public_share_object` run in
 *    one transaction, so first use is one signature and `thenPrepareAgain` is never set here.
 * 2. `pay_with_deep = false` is accepted on POST_ONLY, for both sides, with exactly the order's amount
 *    deposited and no DEEP anywhere. The Move comment saying it must be true is out of date. The
 *    pool's maker fee is 0 today, so nothing is owed in any coin; `prepare` refuses if that changes.
 * 3. `register_balance_manager` is allowed. Its Move source checks the sender is the manager's owner,
 *    then only adds the manager's id to that owner's set in the registry. In simulation it created one
 *    registry entry and moved nothing. That is how a new device finds the manager, and it is why a
 *    stranger can't plant one: nobody else can register a manager for this account.
 */

const VENUE_ID = 'deepbook-limit'
const VENUE_NAME = 'DeepBook'
const SUI_DECIMALS = 9
const USDC_DECIMALS = 6
const READ_TIMEOUT_MS = 10_000
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const MAX_U128 = (BigInt(1) << BigInt(128)) - BigInt(1)
const ZERO = BigInt(0)
const WAITING_NOTE = 'This is in your DeepBook account, not your wallet, until you press Collect.'

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function assertAccount(account: string): void {
  if (!isValidSuiAddress(account)) refused('That is not a Sui address.')
}

const sui = (raw: bigint): string => displayAmount(raw.toString(), SUI_DECIMALS, SUI_DECIMALS)
const usdc = (raw: bigint): string => displayAmount(raw.toString(), USDC_DECIMALS, USDC_DECIMALS)

const poolInput = (tx: Transaction) =>
  tx.sharedObjectRef({
    objectId: DEEPBOOK_POOL,
    initialSharedVersion: DEEPBOOK_POOL_VERSION,
    mutable: false,
  })

const managerInput = (tx: Transaction, manager: ManagerRef) =>
  tx.sharedObjectRef({
    objectId: manager.id,
    initialSharedVersion: manager.version,
    mutable: false,
  })

const POOL_TYPES = { typeArguments: [DEEPBOOK_SUI, DEEPBOOK_USDC] }

/** Each command's return values, from a simulation that signs nothing and changes nothing. */
async function readCalls(
  account: string,
  build: (tx: Transaction) => void,
  signal?: AbortSignal
): Promise<Uint8Array[][]> {
  const tx = new Transaction()
  tx.setSender(account)
  build(tx)
  const result = await withTimeout(
    suiClient().core.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
      ...(signal === undefined ? {} : { signal }),
    }),
    READ_TIMEOUT_MS,
    'Reading DeepBook'
  )
  if (result.$kind !== 'Transaction') throw new Error('A DeepBook read failed.')
  return (result.commandResults ?? []).map((c) => c.returnValues.map((v) => v.bcs))
}

function returned(results: Uint8Array[][], command: number, value = 0): Uint8Array {
  const bytes = results[command]?.[value]
  if (bytes === undefined) throw new Error('A DeepBook read came back short.')
  return bytes
}

const u64Of = (bytes: Uint8Array): bigint => BigInt(bcs.u64().parse(bytes))

/** A read needed before anything can be built. Failing means building nothing, said in words. */
async function mustRead<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof ChainActionRefused) throw e
    return refused(`I couldn’t read ${what} just now, so try again in a moment.`)
  }
}

interface PoolState {
  book: PoolBook
  makerFee: bigint
}

async function readPool(account: string): Promise<PoolState> {
  const results = await readCalls(account, (tx) => {
    tx.moveCall({
      target: DEEPBOOK_READS.bookParams,
      ...POOL_TYPES,
      arguments: [poolInput(tx)],
    })
    tx.moveCall({
      target: DEEPBOOK_READS.tradeParams,
      ...POOL_TYPES,
      arguments: [poolInput(tx)],
    })
  })
  return {
    book: {
      tick: u64Of(returned(results, 0, 0)),
      lot: u64Of(returned(results, 0, 1)),
      min: u64Of(returned(results, 0, 2)),
    },
    makerFee: u64Of(returned(results, 1, 1)),
  }
}

interface Manager extends ManagerRef {
  owner: string
  caps: string[]
}

/**
 * The manager at this id, or nothing if the object there isn't one, isn't shared, or can't be read on
 * its own, as a manager held inside a margin account can't. A failed read still throws.
 */
async function readManager(id: string): Promise<Manager | undefined> {
  const object = await withTimeout(
    suiClient().core.getObject({ objectId: id, include: { content: true } }),
    READ_TIMEOUT_MS,
    'Reading DeepBook'
  ).then(
    (reply) => reply.object,
    (e: unknown) => {
      if (e instanceof Error && /not found/i.test(e.message)) return undefined
      throw e
    }
  )
  if (object === undefined) return undefined
  const owner = object.owner
  if (
    owner.$kind !== 'Shared' ||
    normalizeStructTag(object.type) !== normalizeStructTag(DEEPBOOK_MANAGER_TYPE)
  ) {
    return undefined
  }
  return {
    id: normalizeSuiAddress(id),
    version: owner.Shared.initialSharedVersion,
    ...decodeManager(object.content),
  }
}

async function registeredManagers(
  account: string,
  signal?: AbortSignal
): Promise<(Manager | undefined)[]> {
  const results = await readCalls(
    account,
    (tx) => {
      tx.moveCall({
        target: DEEPBOOK_READS.managerIds,
        arguments: [
          tx.sharedObjectRef({
            objectId: DEEPBOOK_REGISTRY,
            initialSharedVersion: DEEPBOOK_REGISTRY_VERSION,
            mutable: false,
          }),
          tx.pure.address(account),
        ],
      })
    },
    signal
  )
  return Promise.all(decodeIds(returned(results, 0)).map(readManager))
}

/**
 * The manager to deposit into. Its owner is read off the object, whatever the registry says. One with
 * a cap minted on it is passed over, since whoever holds that cap could trade or withdraw what goes
 * in, and a clean one is opened instead.
 */
async function managerFor(account: string): Promise<Manager | 'new'> {
  const me = normalizeSuiAddress(account)
  const managers = await mustRead(() => registeredManagers(account), 'your DeepBook account')
  const held = managers.filter((m): m is Manager => m !== undefined)
  if (held.some((m) => m.owner !== me)) {
    refused('A DeepBook account registered here belongs to another wallet.')
  }
  return held.find((m) => m.caps.length === 0) ?? 'new'
}

/** A failed build has already been put in words, which here also say that nothing happened. */
async function built(tx: Transaction, symbol: string): Promise<string> {
  try {
    return await buildUnsigned(tx, suiClient(), symbol)
  } catch (e) {
    if (e instanceof ChainActionRefused) refused(e.message)
    throw e
  }
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertAccount(account)
  if (request.kind !== 'limit')
    refused(`${VENUE_NAME} only rests orders. It can’t ${request.kind}.`)
  const { input, output, selling } = deepbookPair(request.tokenIn, request.tokenOut ?? '')

  const { book, makerFee } = await mustRead(() => readPool(account), 'DeepBook')
  if (makerFee !== ZERO) {
    refused('DeepBook now charges a fee to rest an order, which I haven’t checked this against.')
  }
  const figures = orderFigures({
    amount: request.amount,
    price: request.limitPrice ?? '',
    selling,
    book,
  })
  const manager = await managerFor(account)
  const expiry = Date.now() + EXPIRY_MS

  const tx = new Transaction()
  tx.setSender(account)
  addPlace(tx, { manager, selling, figures, expiry })
  const transaction = await built(tx, input.symbol)

  const pay = selling ? sui(figures.deposit) : usdc(figures.deposit)
  const receive = selling ? usdc(figures.receive) : sui(figures.receive)
  return {
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: `Offer ${pay} ${input.symbol} on DeepBook for ${receive} ${output.symbol}, at ${usdc(figures.price)} USDC per SUI.`,
    pay: { amount: pay, symbol: input.symbol },
    receive: { amount: receive, symbol: output.symbol, approximate: false },
    notes: [
      ...(manager === 'new'
        ? ['This opens a DeepBook account that only you control, to hold the order’s tokens.']
        : []),
      'Filled or cancelled tokens stay in your DeepBook account until you press Collect, which needs a second signature.',
      'Expires in 7 days. Anything unfilled then waits to be collected.',
      'It never fills at once. If the price has already passed yours, placing it fails and nothing moves.',
    ],
    signing: { family: 'sui', transaction },
    context: {
      manager: manager === 'new' ? 'new' : manager.id,
      side: selling ? 'sell' : 'buy',
      price: figures.price.toString(),
      quantity: figures.quantity.toString(),
      deposit: figures.deposit.toString(),
      expiry: String(expiry),
    },
  }
}

/**
 * `limitCost` is what a first order costs in storage, with room to spare: simulated on 5 November 2026
 * at 0.0099 SUI net for a new manager and its registry entry, and a budget of 0.009 SUI. Storage is
 * charged net of a rebate on the pool's objects it rewrites, so most of the gross 0.074 SUI comes back
 * in the same transaction.
 */
export const deepbookVenue: ChainVenue = {
  id: VENUE_ID,
  name: VENUE_NAME,
  kinds: ['limit'],
  prepare,
  assertSafe: deepbookAssertSafe,
  limitCost: { amount: '0.02', symbol: 'SUI' },
}

interface ManagerHoldings {
  orders: BookOrder[]
  /** In the manager, or settled in the pool's record for it. Either way, not in the wallet. */
  base: bigint
  quote: bigint
}

async function readHoldings(
  account: string,
  manager: ManagerRef,
  signal?: AbortSignal
): Promise<ManagerHoldings> {
  const first = await readCalls(
    account,
    (tx) => {
      const held = managerInput(tx, manager)
      tx.moveCall({
        target: DEEPBOOK_READS.accountExists,
        ...POOL_TYPES,
        arguments: [poolInput(tx), held],
      })
      for (const coin of [DEEPBOOK_SUI, DEEPBOOK_USDC]) {
        tx.moveCall({
          target: DEEPBOOK_READS.balance,
          typeArguments: [coin],
          arguments: [held],
        })
      }
    },
    signal
  )
  const base = u64Of(returned(first, 1))
  const quote = u64Of(returned(first, 2))
  if (!bcs.bool().parse(returned(first, 0))) return { orders: [], base, quote }

  const second = await readCalls(
    account,
    (tx) => {
      const held = managerInput(tx, manager)
      tx.moveCall({
        target: DEEPBOOK_READS.account,
        ...POOL_TYPES,
        arguments: [poolInput(tx), held],
      })
      tx.moveCall({
        target: DEEPBOOK_READS.orders,
        ...POOL_TYPES,
        arguments: [poolInput(tx), held],
      })
    },
    signal
  )
  const settled = decodeSettled(returned(second, 0))
  return {
    orders: decodeOrders(returned(second, 1)),
    base: base + settled.base,
    quote: quote + settled.quote,
  }
}

function restingOrder(manager: string, order: BookOrder): RestingOrder {
  const { isBid, price } = decodeOrderId(order.id)
  const remaining = order.quantity - order.filled
  const filled = order.filled > ZERO
  const note =
    order.expires <= Date.now()
      ? 'It has expired and can no longer fill. Cancel brings back what is left.'
      : filled
        ? 'What has filled so far is in your DeepBook account, not your wallet, until you collect it.'
        : undefined
  return {
    id: `${manager}:${order.id}`,
    venueId: VENUE_ID,
    tokenIn: isBid ? 'USDC' : 'SUI',
    tokenOut: isBid ? 'SUI' : 'USDC',
    amountIn: isBid ? usdc(quoteOf(order.quantity, price)) : sui(order.quantity),
    remainingIn: isBid ? usdc(quoteOf(remaining, price)) : sui(remaining),
    receivedOut: isBid ? sui(order.filled) : usdc(quoteOf(order.filled, price)),
    limitPrice: usdc(price),
    status: filled ? 'partly' : 'open',
    expiresAt: order.expires,
    ...(note === undefined ? {} : { note }),
  }
}

function waitingRow(manager: string, base: bigint, quote: bigint): RestingOrder | undefined {
  const collectable = [
    ...(quote > ZERO ? [{ amount: usdc(quote), symbol: 'USDC' }] : []),
    ...(base > ZERO ? [{ amount: sui(base), symbol: 'SUI' }] : []),
  ]
  const [first] = collectable
  if (first === undefined) return undefined
  return {
    id: manager,
    venueId: VENUE_ID,
    tokenIn: first.symbol === 'USDC' ? 'SUI' : 'USDC',
    tokenOut: first.symbol,
    amountIn: '0',
    remainingIn: '0',
    receivedOut: first.amount,
    collectable,
    status: 'filled',
    note: WAITING_NOTE,
  }
}

async function openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]> {
  assertAccount(account)
  const me = normalizeSuiAddress(account)
  const managers = (await registeredManagers(account, signal)).filter(
    (m): m is Manager => m !== undefined && m.owner === me
  )
  const rows = await Promise.all(
    managers.map(async (manager) => {
      const { orders, base, quote } = await readHoldings(account, manager, signal)
      const waiting = waitingRow(manager.id, base, quote)
      return [
        ...orders.map((order) => restingOrder(manager.id, order)),
        ...(waiting === undefined ? [] : [waiting]),
      ]
    })
  )
  return rows.flat()
}

/** An order's id here: its manager, then the order. The manager alone is the row of waiting money. */
function parseOrderKey(orderId: string): { manager: string; order?: bigint } {
  const match = /^(0x[0-9a-fA-F]{64})(?::(\d{1,39}))?$/.exec(orderId)
  const manager = match?.[1]
  if (manager === undefined) refused('That is not a DeepBook order.')
  const order = match?.[2] === undefined ? undefined : BigInt(match[2])
  if (order !== undefined && order > MAX_U128) refused('That is not a DeepBook order.')
  return { manager: normalizeSuiAddress(manager), ...(order === undefined ? {} : { order }) }
}

function amounts(base: bigint, quote: bigint): string {
  return [
    ...(base > ZERO ? [`${sui(base)} SUI`] : []),
    ...(quote > ZERO ? [`${usdc(quote)} USDC`] : []),
  ].join(' and ')
}

async function prepareExit(
  account: string,
  orderId: string,
  action: 'cancel' | 'collect'
): Promise<PreparedAction> {
  assertAccount(account)
  const key = parseOrderKey(orderId)
  const manager = await mustRead(() => readManager(key.manager), 'that order')
  if (manager === undefined) refused('That is not a DeepBook order.')
  if (manager.owner !== normalizeSuiAddress(account)) {
    refused('That order belongs to another wallet.')
  }
  const { orders, base, quote } = await mustRead(() => readHoldings(account, manager), 'that order')

  const tx = new Transaction()
  tx.setSender(account)
  const signing = (transaction: string) => ({ family: 'sui' as const, transaction })

  if (action === 'collect') {
    if (base === ZERO && quote === ZERO) {
      refused('There is nothing waiting in that DeepBook account to collect.')
    }
    addExit(tx, { account, manager })
    const inSui = base > ZERO
    return {
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      kind: 'limit',
      summary: `Move ${amounts(base, quote)} from your DeepBook account to your wallet.`,
      pay: { amount: '0', symbol: inSui ? 'SUI' : 'USDC' },
      receive: {
        amount: inSui ? sui(base) : usdc(quote),
        symbol: inSui ? 'SUI' : 'USDC',
        approximate: false,
      },
      notes: ['Any order still open on this account stays open.'],
      signing: signing(await built(tx, 'SUI')),
    }
  }

  if (key.order === undefined) {
    refused('That is money waiting in your DeepBook account, so there is nothing to cancel.')
  }
  const order = orders.find((o) => o.id === key.order)
  if (order === undefined) {
    refused('That order is no longer open. If it filled, Collect brings the money back.')
  }
  const { isBid, price } = decodeOrderId(order.id)
  const left = order.quantity - order.filled
  const backBase = isBid ? base : base + left
  const backQuote = isBid ? quote + quoteOf(left, price) : quote
  addExit(tx, { account, manager, order: order.id })
  return {
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: `Cancel your DeepBook order and bring ${amounts(backBase, backQuote)} back to your wallet.`,
    pay: { amount: '0', symbol: isBid ? 'USDC' : 'SUI' },
    receive: {
      amount: isBid ? usdc(quoteOf(left, price)) : sui(left),
      symbol: isBid ? 'USDC' : 'SUI',
      approximate: false,
    },
    notes: [
      'This also brings back anything else waiting in this DeepBook account.',
      'It could fill before this lands. Whatever filled comes back to your wallet too.',
    ],
    signing: signing(await built(tx, 'SUI')),
  }
}

export function deepbookBook(): LimitBook {
  return { openOrders, prepareExit }
}
