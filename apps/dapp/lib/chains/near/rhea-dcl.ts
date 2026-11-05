import { z } from 'zod'

import { limitOutput, type LimitBook, type RestingOrder } from '../limit'
import { fromBase } from '../sequence'
import {
  ChainActionRefused,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type NearTransaction,
  type PreparedAction,
  type SubmitInput,
  type SubmitResult,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import {
  assertRestingPoint,
  DCL_CONTRACT,
  DCL_EXIT_GAS,
  DCL_ORDER_GAS,
  DCL_POINT_DELTA,
  DCL_POOL,
  DCL_STORAGE_CAP,
  dclOrderMsg,
  isDclOrderId,
  pointForPrice,
  priceAtPoint,
  readExecuted,
  rheaPair,
  type RheaPair,
} from './rhea-dcl-rules'
import { isRegistered, viewCall, waitForTransaction } from './rpc'
import { assertRheaDclSafe, STORAGE_DEPOSIT_YOCTO, STORAGE_GAS, WRAP_GAS } from './safety'
import { explorerUrl, formatUnits, nearTokens, USDC_NEAR, WRAP_NEAR } from './tokens'

/**
 * Read off mainnet on 5 November 2026, with nothing signed (`near-rhea-dcl.live.test.ts`, and
 * docs/research/2026-11-05-limit-orders/near.md for the transactions behind each):
 *
 * 1. Several transactions don't carry a first use safely. NEAR Connect hands the array to whichever
 *    wallet is connected, promises neither their order nor to stop after a failure, and returns
 *    nothing if it fails partway. So storage is its own signature, with `thenPrepareAgain`, and the
 *    order is only built once the chain shows the storage is there.
 * 2. `cancel_order` with `{order_id, amount}` pays bought or returned wNEAR as native NEAR, because the
 *    contract unwraps it unless told not to with `skip_unwrap_near`. So a purchase pays out in NEAR.
 * 3. `bought_amount` includes `unclaimed_amount`, and a filled order stays in `list_active_orders`
 *    with `remain_amount` "0" until it is collected.
 * 4. An `amount` above what is left is cut to what is left, so a cancel survives a fill before it lands.
 */

export const RHEA_VENUE_ID = 'rhea-limit'
const VENUE_NAME = 'Rhea'
const NEAR_DECIMALS = 24
const CONFIRM_WAIT_MS = 25_000
const ORDER_SEEN_WAIT_MS = 8_000
const ORDER_SEEN_POLL_MS = 1_500

const NOTES = [
  'When it fills, press Collect to receive it. That needs a second signature.',
  'First use sets aside up to 0.5 NEAR for storage on Rhea. I could not confirm it comes back.',
  'A purchase pays out in NEAR.',
  'This stays open until it fills or you cancel it.',
]

const Amount = z.string().regex(/^\d+$/)

const Pool = z.object({
  token_x: z.string(),
  token_y: z.string(),
  point_delta: z.number(),
  current_point: z.number().int(),
  state: z.string(),
  tax: z.unknown(),
})

const Metadata = z.object({ state: z.string() })

const StorageDetail = z
  .object({
    max_slots: z.number(),
    cur_order_slots: z.number(),
    cur_liquidity_slots: z.number(),
  })
  .nullable()

const Bounds = z.object({ min: Amount })

const Order = z.object({
  order_id: z.string(),
  owner_id: z.string(),
  pool_id: z.string(),
  point: z.number().int(),
  sell_token: z.string(),
  buy_token: z.string(),
  original_amount: Amount,
  remain_amount: Amount,
  bought_amount: Amount,
  unclaimed_amount: Amount.nullable(),
})

type DclOrder = z.infer<typeof Order>

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function assertAccount(account: string): void {
  if (!NEAR_ACCOUNT.test(account)) refused('That is not a NEAR account.')
}

/** A read needed before anything can be built. Failing means building nothing, said in words. */
async function mustRead<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof ChainActionRefused) throw e
    return refused(`I couldn’t read ${what} just now, so try again in a moment.`)
  }
}

function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: string
): NearTransaction['actions'][number] {
  return { type: 'FunctionCall', params: { methodName, args, gas: gas.toString(), deposit } }
}

function storageTransaction(receiverId: string, account: string, deposit: string): NearTransaction {
  return {
    receiverId,
    actions: [
      functionCall(
        'storage_deposit',
        { account_id: account, registration_only: true },
        STORAGE_GAS,
        deposit
      ),
    ],
  }
}

type StorageRecord = z.infer<typeof StorageDetail>

interface Setup {
  record: StorageRecord
  /** The storage still owed, in the order it is paid. Empty once the order can be placed. */
  transactions: NearTransaction[]
  owed: bigint
}

/** What the chain says this account still has to pay for, and refuses more than the cap. */
async function readSetup(account: string, pair: RheaPair): Promise<Setup> {
  const [detail, buyRegistered, wrapRegistered] = await Promise.all([
    viewCall<unknown>(DCL_CONTRACT, 'get_user_storage_detail', { user_id: account }),
    isRegistered(pair.output.id, account),
    pair.selling ? isRegistered(WRAP_NEAR, account) : true,
  ])
  const record = StorageDetail.parse(detail)
  const transactions: NearTransaction[] = []
  let owed = BigInt(0)
  const pay = (receiverId: string, deposit: string): void => {
    transactions.push(storageTransaction(receiverId, account, deposit))
    owed += BigInt(deposit)
  }
  if (record === null) {
    const { min } = Bounds.parse(await viewCall<unknown>(DCL_CONTRACT, 'storage_balance_bounds'))
    if (BigInt(min) > DCL_STORAGE_CAP) {
      refused('Rhea now asks for more than the 0.5 NEAR of storage I accept.')
    }
    pay(DCL_CONTRACT, min)
  }
  if (!buyRegistered) pay(pair.output.id, STORAGE_DEPOSIT_YOCTO)
  if (!wrapRegistered) pay(WRAP_NEAR, STORAGE_DEPOSIT_YOCTO)
  return { record, transactions, owed }
}

async function limitCostNow(
  request: ChainActionRequest,
  account: string
): Promise<ChainVenue['limitCost']> {
  const { owed } = await readSetup(account, rheaPair(request.tokenIn, request.tokenOut ?? ''))
  return owed === BigInt(0) ? undefined : { amount: fromBase(owed, NEAR_DECIMALS), symbol: 'NEAR' }
}

/** The pool has to be the one this was checked against, and open. */
async function readCurrentPoint(): Promise<number> {
  const [poolRow, metadata] = await Promise.all([
    viewCall<unknown>(DCL_CONTRACT, 'get_pool', { pool_id: DCL_POOL }),
    viewCall<unknown>(DCL_CONTRACT, 'get_metadata'),
  ])
  const pool = Pool.parse(poolRow)
  if (Metadata.parse(metadata).state !== 'Running' || pool.state !== 'Running') {
    refused('Rhea is not taking orders on this pool right now.')
  }
  if (
    pool.token_x !== USDC_NEAR ||
    pool.token_y !== WRAP_NEAR ||
    pool.point_delta !== DCL_POINT_DELTA ||
    (pool.tax !== null && pool.tax !== undefined)
  ) {
    refused('This Rhea pool has changed since I last checked it.')
  }
  return pool.current_point
}

function baseUnits(amount: string, token: ChainToken): string {
  try {
    return toBaseUnits(amount, token.decimals)
  } catch (e) {
    if (e instanceof ChainActionRefused) refused(e.message)
    throw e
  }
}

function orderTransaction(pair: RheaPair, amount: string, point: number): NearTransaction {
  const order = functionCall(
    'ft_transfer_call',
    { receiver_id: DCL_CONTRACT, amount, msg: dclOrderMsg(pair.output.id, point) },
    DCL_ORDER_GAS,
    '1'
  )
  return {
    receiverId: pair.input.id,
    actions: pair.selling ? [functionCall('near_deposit', {}, WRAP_GAS, amount), order] : [order],
  }
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertAccount(account)
  if (request.kind !== 'limit') {
    refused(`${VENUE_NAME} only rests orders. It can’t ${request.kind}.`)
  }
  const pair = rheaPair(request.tokenIn, request.tokenOut ?? '')
  const { input, output, selling } = pair
  const amount = baseUnits(request.amount, input)
  const limitPrice = request.limitPrice ?? ''
  const received = limitOutput(request.amount, limitPrice, selling, input.decimals, output.decimals)
  if (received === BigInt(0)) refused('That order is too small to place.')
  const point = pointForPrice(Number(limitPrice), selling, DCL_POINT_DELTA)

  assertRestingPoint(point, await mustRead(readCurrentPoint, 'Rhea'), selling)
  const setup = await mustRead(() => readSetup(account, pair), 'Rhea')
  const context = { sellToken: input.id, amount, point: String(point) }

  if (setup.transactions.length > 0) {
    const cost = fromBase(setup.owed, NEAR_DECIMALS)
    return {
      venueId: RHEA_VENUE_ID,
      venueName: VENUE_NAME,
      kind: 'limit',
      summary: `Set up your account on Rhea for ${cost} NEAR of storage. You sign the order itself next, and nothing is offered until then.`,
      pay: { amount: cost, symbol: 'NEAR' },
      notes: NOTES,
      signing: { family: 'near', transactions: setup.transactions },
      context,
      thenPrepareAgain: true,
    }
  }

  const { record } = setup
  if (
    record !== null &&
    record.cur_order_slots + record.cur_liquidity_slots + 1 > record.max_slots
  ) {
    refused('Your Rhea account has no free order slot. Cancel or collect an order first.')
  }
  const existing = await mustRead(
    () =>
      viewCall<unknown>(DCL_CONTRACT, 'find_order', {
        account_id: account,
        pool_id: DCL_POOL,
        point,
      }),
    'Rhea'
  )
  if (existing !== null) {
    refused('You already have a Rhea order at that price. Cancel it or name another price.')
  }

  const receive = formatUnits(received.toString(), output.decimals)
  return {
    venueId: RHEA_VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: `Offer ${request.amount} ${input.symbol} on Rhea for about ${receive} ${output.symbol}, at ${limitPrice} USDC per NEAR.`,
    pay: { amount: request.amount, symbol: input.symbol },
    receive: { amount: receive, symbol: output.symbol, approximate: true },
    notes: NOTES,
    signing: { family: 'near', transactions: [orderTransaction(pair, amount, point)] },
    context,
  }
}

function tokenOn(id: string): ChainToken {
  const token = nearTokens.find((t) => t.id === id)
  if (token === undefined) throw new Error(`${id} is not in the token table`)
  return token
}

function waitingAmount(order: DclOrder): bigint {
  return BigInt(order.unclaimed_amount ?? '0')
}

function restingOrder(order: DclOrder): RestingOrder {
  const sell = tokenOn(order.sell_token)
  const buy = tokenOn(order.buy_token)
  const waiting = waitingAmount(order)
  const open = BigInt(order.remain_amount) > BigInt(0)
  const started = BigInt(order.bought_amount) > BigInt(0) || waiting > BigInt(0)
  return {
    id: order.order_id,
    venueId: RHEA_VENUE_ID,
    tokenIn: sell.symbol,
    tokenOut: buy.symbol,
    amountIn: formatUnits(order.original_amount, sell.decimals),
    remainingIn: formatUnits(order.remain_amount, sell.decimals),
    receivedOut: formatUnits(order.bought_amount, buy.decimals),
    limitPrice: String(Number(priceAtPoint(order.point).toPrecision(6))),
    status: !open ? 'filled' : started ? 'partly' : 'open',
    ...(waiting > BigInt(0)
      ? {
          collectable: [
            { amount: formatUnits(waiting.toString(), buy.decimals), symbol: buy.symbol },
          ],
          note: 'What has filled waits on Rhea until you press Collect.',
        }
      : {}),
  }
}

async function openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]> {
  assertAccount(account)
  const rows = z
    .array(Order)
    .parse(
      await viewCall<unknown>(DCL_CONTRACT, 'list_active_orders', { account_id: account }, signal)
    )
  return rows.filter((order) => order.pool_id === DCL_POOL).map(restingOrder)
}

async function prepareExit(
  account: string,
  orderId: string,
  action: 'cancel' | 'collect'
): Promise<PreparedAction> {
  assertAccount(account)
  if (!isDclOrderId(orderId)) refused('That is not a Rhea order I can change.')
  const order = await mustRead(
    async () =>
      Order.nullable().parse(
        await viewCall<unknown>(DCL_CONTRACT, 'get_order', { order_id: orderId })
      ),
    'that order'
  )
  if (order === null) refused('That order is no longer open.')
  if (order.owner_id !== account) refused('That order belongs to another wallet.')
  if (order.order_id !== orderId || order.pool_id !== DCL_POOL) {
    refused('That is not a Rhea order I can change.')
  }
  const sell = tokenOn(order.sell_token)
  const buy = tokenOn(order.buy_token)
  const exit = (amount: string): PreparedAction['signing'] => ({
    family: 'near',
    transactions: [
      {
        receiverId: DCL_CONTRACT,
        actions: [functionCall('cancel_order', { order_id: orderId, amount }, DCL_EXIT_GAS, '0')],
      },
    ],
  })
  const shared = {
    venueId: RHEA_VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit' as const,
    context: { orderId },
  }

  if (action === 'collect') {
    const waiting = waitingAmount(order)
    if (waiting === BigInt(0)) refused('That order has nothing to collect yet.')
    const amount = formatUnits(waiting.toString(), buy.decimals)
    return {
      ...shared,
      summary: `Collect about ${amount} ${buy.symbol} from your Rhea order into your wallet.`,
      pay: { amount: '0', symbol: sell.symbol },
      receive: { amount, symbol: buy.symbol, approximate: true },
      notes: ['Any part still open stays open.'],
      signing: exit('0'),
    }
  }

  if (order.remain_amount === '0') {
    refused('That order has already filled, so there is nothing to cancel. Collect it instead.')
  }
  const remaining = formatUnits(order.remain_amount, sell.decimals)
  return {
    ...shared,
    summary: `Cancel your Rhea order and get back about ${remaining} ${sell.symbol}, plus anything it has bought.`,
    pay: { amount: '0', symbol: sell.symbol },
    receive: { amount: remaining, symbol: sell.symbol, approximate: true },
    notes: ['It could fill before this lands. Whatever filled comes back to your wallet too.'],
    signing: exit(order.remain_amount),
  }
}

export function rheaBook(): LimitBook {
  return { openOrders, prepareExit }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether the order is resting. A token transaction succeeds even when Rhea sends the tokens straight
 * back, so its own status can't say so. A view reads at `final`, a moment behind the transaction.
 */
async function orderSeen(account: string, point: number): Promise<boolean> {
  const giveUpAt = Date.now() + ORDER_SEEN_WAIT_MS
  while (Date.now() < giveUpAt) {
    try {
      const order = await viewCall<unknown>(DCL_CONTRACT, 'find_order', {
        account_id: account,
        pool_id: DCL_POOL,
        point,
      })
      if (order !== null) return true
    } catch {
      // A brief RPC failure means look again.
    }
    await delay(ORDER_SEEN_POLL_MS)
  }
  return false
}

/**
 * Confirms what a NEAR wallet already sent. Each transaction must have run as this account and be one
 * of this venue's own calls. What the calls did is read off the chain, and never from the browser.
 */
async function confirmRhea(input: SubmitInput): Promise<SubmitResult> {
  const { account, signed } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || signed.hashes.some((h) => !NEAR_TX_HASH.test(h))) {
    return {
      ok: false,
      pending: true,
      error: 'The wallet did not return a transaction hash to follow.',
    }
  }

  const giveUpAt = Date.now() + CONFIRM_WAIT_MS
  let placed: number | undefined
  for (const each of signed.hashes) {
    const outcome = await waitForTransaction(each, account, Math.max(giveUpAt - Date.now(), 1))
    if (outcome.state === 'unknown') {
      return {
        ok: false,
        pending: true,
        error: `Your transaction was sent (${each}) but hasn't been confirmed yet. Don't send it again. Check ${explorerUrl(each)} in a minute.`,
      }
    }
    const read = readExecuted(outcome.receiver, outcome.calls)
    if (outcome.signer !== account || !read.belongs) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${each} is not this account's order on Rhea. Check your wallet's activity.`,
      }
    }
    if (outcome.state === 'failed') {
      return read.point === undefined
        ? {
            ok: false,
            error: `That failed on NEAR (${each}), so what it attached came back, apart from the gas. You can try again.`,
          }
        : {
            ok: false,
            pending: true,
            error: `The order failed on NEAR (${each}). Check your wallet's activity before trying again.`,
          }
    }
    placed = read.point ?? placed
  }

  if (placed !== undefined && !(await orderSeen(account, placed))) {
    return {
      ok: false,
      pending: true,
      error: `Your transaction went through (${hash}), but I can't see the order resting on Rhea. It may have filled at once, or your tokens may have come back, wrapped if you sold NEAR. Check your wallet before trying again.`,
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}

/** `limitCost` is the most first use comes to. `limitCostNow` is what the reserve goes by. */
export const rheaVenue: ChainVenue = {
  id: RHEA_VENUE_ID,
  name: VENUE_NAME,
  kinds: ['limit'],
  prepare,
  assertSafe: assertRheaDclSafe,
  submit: confirmRhea,
  limitCost: { amount: '0.5', symbol: 'NEAR' },
  limitCostNow,
}
