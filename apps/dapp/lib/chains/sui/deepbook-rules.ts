import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, type Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import { limitPair } from '../limit'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainToken,
  type SigningPayload,
} from '../types'
import {
  DEEPBOOK_CALLS,
  DEEPBOOK_MANAGER_TYPE,
  DEEPBOOK_PACKAGE,
  DEEPBOOK_POLICY,
  DEEPBOOK_POOL,
  DEEPBOOK_POOL_VERSION,
  DEEPBOOK_POST_ONLY,
  DEEPBOOK_REGISTRY,
  DEEPBOOK_REGISTRY_VERSION,
  DEEPBOOK_SELF_MATCHING,
  DEEPBOOK_SUI,
  DEEPBOOK_USDC,
} from './policies'
import {
  assertPtbSafe,
  moveTarget,
  objectReaderFor,
  parsePtb,
  readerFor,
  type ReadObject,
  type ReadPure,
} from './safety'
import { displayAmount, SUI_TOKENS } from './tokens'

type TxData = ReturnType<typeof parsePtb>
type TxCommand = TxData['commands'][number]
type TxArgument = Extract<TxCommand, { $kind: 'MoveCall' }>['MoveCall']['arguments'][number]

/** Move's fixed-point scale. A price is quote units per base unit, times this. */
const FLOAT_SCALE = BigInt(1_000_000_000)
const SUI_DECIMALS = 9
const USDC_DECIMALS = 6
const ZERO = BigInt(0)

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

const ten = (n: number): bigint => BigInt(10) ** BigInt(n)

/** The pool's sizes, in base units. Always read from the chain: the indexer has disagreed with it. */
export interface PoolBook {
  tick: bigint
  lot: bigint
  min: bigint
}

export interface OrderFigures {
  /** On the tick. */
  price: bigint
  /** SUI in base units, on the lot. */
  quantity: bigint
  /** What goes into the manager: SUI for a sell, USDC for a buy. */
  deposit: bigint
  /** What it brings once it has filled: USDC for a sell, SUI for a buy. */
  receive: bigint
}

function baseUnits(amount: string, decimals: number): bigint {
  try {
    return BigInt(toBaseUnits(amount, decimals))
  } catch (e) {
    if (e instanceof ChainActionRefused) refused(e.message)
    throw e
  }
}

/**
 * The order to place, from what the person said. A sell's price rounds up to the tick and a buy's
 * rounds down, so neither ever trades worse than the price stated, and a quantity off the lot rounds
 * down. A buy deposits only what its rounded quantity holds, so nothing is left idle in the manager.
 */
export function orderFigures(input: {
  amount: string
  price: string
  selling: boolean
  book: PoolBook
}): OrderFigures {
  const { amount, selling, book } = input
  const text = input.price.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) refused(`"${input.price}" is not a price.`)
  const [whole = '0', fraction = ''] = text.split('.')
  const top = BigInt(`${whole}${fraction}`) * ten(USDC_DECIMALS)
  const bottom = ten(fraction.length) * book.tick
  const ticks = selling ? (top + bottom - BigInt(1)) / bottom : top / bottom
  const price = ticks * book.tick
  if (price === ZERO) refused('That price is too small for DeepBook.')

  const given = baseUnits(amount, selling ? SUI_DECIMALS : USDC_DECIMALS)
  const wanted = selling ? given : (given * FLOAT_SCALE) / price
  const quantity = (wanted / book.lot) * book.lot
  if (quantity < book.min) {
    refused(
      `DeepBook's smallest SUI order is ${displayAmount(book.min.toString(), SUI_DECIMALS, SUI_DECIMALS)} SUI.`
    )
  }
  const quote = (quantity * price) / FLOAT_SCALE
  return selling
    ? { price, quantity, deposit: quantity, receive: quote }
    : { price, quantity, deposit: quote, receive: quantity }
}

/** What each side of a new order is, or a refusal for any pair but SUI against USDC. */
export function deepbookPair(
  tokenIn: string,
  tokenOut: string
): { input: ChainToken; output: ChainToken; selling: boolean } {
  const input = tokenBySymbol(SUI_TOKENS, tokenIn)
  const output = tokenBySymbol(SUI_TOKENS, tokenOut)
  const pair = limitPair(tokenIn, tokenOut)
  const symbols = [input?.symbol, output?.symbol].sort().join('/')
  if (input === undefined || output === undefined || pair === undefined || symbols !== 'SUI/USDC') {
    refused('DeepBook orders here take SUI against USDC only.')
  }
  return { input, output, selling: pair.selling }
}

/** Where a shared manager was first shared, which a transaction names along with its id. */
export interface ManagerRef {
  id: string
  version: string
}

export interface PlacePlan {
  /** `new` when this order creates the manager, and shares it last. */
  manager: ManagerRef | 'new'
  selling: boolean
  figures: OrderFigures
  expiry: number
}

const pool = (tx: Transaction) =>
  tx.sharedObjectRef({
    objectId: DEEPBOOK_POOL,
    initialSharedVersion: DEEPBOOK_POOL_VERSION,
    mutable: true,
  })

const managerInput = (tx: Transaction, manager: ManagerRef) =>
  tx.sharedObjectRef({
    objectId: manager.id,
    initialSharedVersion: manager.version,
    mutable: true,
  })

/**
 * The whole order in one transaction. A manager created here is an ordinary value until the last step
 * shares it, so the steps before can use it by its result. See `deepbook.ts` for the simulation.
 */
export function addPlace(tx: Transaction, plan: PlacePlan): void {
  const { selling, figures, expiry } = plan
  const coin = tx.add(
    selling
      ? coinWithBalance({ balance: figures.deposit })
      : coinWithBalance({ type: DEEPBOOK_USDC, balance: figures.deposit, useGasCoin: false })
  )
  const manager =
    plan.manager === 'new'
      ? tx.moveCall({ target: DEEPBOOK_CALLS.newManager })
      : managerInput(tx, plan.manager)
  tx.moveCall({
    target: DEEPBOOK_CALLS.deposit,
    typeArguments: [selling ? DEEPBOOK_SUI : DEEPBOOK_USDC],
    arguments: [manager, coin],
  })
  const proof = tx.moveCall({ target: DEEPBOOK_CALLS.proof, arguments: [manager] })
  tx.moveCall({
    target: DEEPBOOK_CALLS.place,
    typeArguments: [DEEPBOOK_SUI, DEEPBOOK_USDC],
    arguments: [
      pool(tx),
      manager,
      proof,
      tx.pure.u64(0),
      tx.pure.u8(DEEPBOOK_POST_ONLY),
      tx.pure.u8(DEEPBOOK_SELF_MATCHING),
      tx.pure.u64(figures.price),
      tx.pure.u64(figures.quantity),
      tx.pure.bool(!selling),
      tx.pure.bool(false),
      tx.pure.u64(expiry),
      tx.object.clock(),
    ],
  })
  if (plan.manager !== 'new') return
  tx.moveCall({
    target: DEEPBOOK_CALLS.register,
    arguments: [
      manager,
      tx.sharedObjectRef({
        objectId: DEEPBOOK_REGISTRY,
        initialSharedVersion: DEEPBOOK_REGISTRY_VERSION,
        mutable: true,
      }),
    ],
  })
  tx.moveCall({
    target: DEEPBOOK_CALLS.share,
    typeArguments: [DEEPBOOK_MANAGER_TYPE],
    arguments: [manager],
  })
}

/**
 * Brings what a manager holds back to the account. A fill stays in the pool's record for the manager
 * until it is settled, and `withdraw_all` alone would leave it there: cancelling settles it, and
 * collecting has to ask. `order` is an order to cancel, or nothing to collect.
 */
export function addExit(
  tx: Transaction,
  input: { account: string; manager: ManagerRef; order?: bigint | undefined }
): void {
  const manager = managerInput(tx, input.manager)
  const proof = tx.moveCall({ target: DEEPBOOK_CALLS.proof, arguments: [manager] })
  const types = { typeArguments: [DEEPBOOK_SUI, DEEPBOOK_USDC] }
  if (input.order === undefined) {
    tx.moveCall({
      target: DEEPBOOK_CALLS.settle,
      ...types,
      arguments: [pool(tx), manager, proof],
    })
  } else {
    tx.moveCall({
      target: DEEPBOOK_CALLS.cancel,
      ...types,
      arguments: [pool(tx), manager, proof, tx.pure.u128(input.order), tx.object.clock()],
    })
  }
  const coins = [DEEPBOOK_SUI, DEEPBOOK_USDC].map((coin) =>
    tx.moveCall({
      target: DEEPBOOK_CALLS.withdrawAll,
      typeArguments: [coin],
      arguments: [manager],
    })
  )
  tx.transferObjects(coins, input.account)
}

const VecSetOfIds = bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) })

const ManagerLayout = bcs.struct('BalanceManager', {
  id: bcs.Address,
  owner: bcs.Address,
  balances: bcs.struct('Bag', { id: bcs.Address, size: bcs.u64() }),
  allow_listed: VecSetOfIds,
})

const BalancesLayout = bcs.struct('Balances', {
  base: bcs.u64(),
  quote: bcs.u64(),
  deep: bcs.u64(),
})

const AccountLayout = bcs.struct('Account', {
  epoch: bcs.u64(),
  open_orders: bcs.struct('VecSet', { contents: bcs.vector(bcs.u128()) }),
  taker_volume: bcs.u128(),
  maker_volume: bcs.u128(),
  active_stake: bcs.u64(),
  inactive_stake: bcs.u64(),
  created_proposal: bcs.bool(),
  voted_proposal: bcs.option(bcs.Address),
  unclaimed_rebates: BalancesLayout,
  settled_balances: BalancesLayout,
  owed_balances: BalancesLayout,
})

const OrderLayout = bcs.struct('Order', {
  balance_manager_id: bcs.Address,
  order_id: bcs.u128(),
  client_order_id: bcs.u64(),
  quantity: bcs.u64(),
  filled_quantity: bcs.u64(),
  fee_is_deep: bcs.bool(),
  order_deep_price: bcs.struct('OrderDeepPrice', {
    asset_is_base: bcs.bool(),
    deep_per_asset: bcs.u64(),
  }),
  epoch: bcs.u64(),
  status: bcs.u8(),
  expire_timestamp: bcs.u64(),
})

/** The owner, and the ids of any caps that can act on the manager without being its owner. */
export function decodeManager(bytes: Uint8Array): { owner: string; caps: string[] } {
  const manager = ManagerLayout.parse(bytes)
  return {
    owner: normalizeSuiAddress(manager.owner),
    caps: manager.allow_listed.contents,
  }
}

export function decodeIds(bytes: Uint8Array): string[] {
  return VecSetOfIds.parse(bytes).contents.map((id) => normalizeSuiAddress(id))
}

/** What fills have left in the pool's record for a manager, which is not in the manager yet. */
export function decodeSettled(bytes: Uint8Array): { base: bigint; quote: bigint } {
  const { base, quote } = AccountLayout.parse(bytes).settled_balances
  return { base: BigInt(base), quote: BigInt(quote) }
}

export interface BookOrder {
  id: bigint
  quantity: bigint
  filled: bigint
  expires: number
}

export function decodeOrders(bytes: Uint8Array): BookOrder[] {
  return bcs
    .vector(OrderLayout)
    .parse(bytes)
    .map((order) => ({
      id: BigInt(order.order_id),
      quantity: BigInt(order.quantity),
      filled: BigInt(order.filled_quantity),
      expires: Number(order.expire_timestamp),
    }))
}

/** An order's id holds its side and price: see `encode_order_id` in DeepBook's `utils.move`. */
export function decodeOrderId(id: bigint): { isBid: boolean; price: bigint } {
  return {
    isBid: id >> BigInt(127) === ZERO,
    price: (id >> BigInt(64)) & ((BigInt(1) << BigInt(63)) - BigInt(1)),
  }
}

/** Quote units for a base quantity at a price, rounded down as DeepBook's `math::mul` is. */
export const quoteOf = (quantity: bigint, price: bigint): bigint => (quantity * price) / FLOAT_SCALE

const FUNDING_CALLS: ReadonlySet<string> = new Set([
  moveTarget('0x2', 'coin', 'redeem_funds'),
  moveTarget('0x2', 'coin', 'destroy_zero'),
  moveTarget('0x2', 'coin', 'send_funds'),
])

const targetOf = (command: TxCommand): string =>
  command.$kind === 'MoveCall'
    ? moveTarget(command.MoveCall.package, command.MoveCall.module, command.MoveCall.function)
    : command.$kind

const isFunding = (command: TxCommand): boolean =>
  command.$kind === 'SplitCoins' ||
  command.$kind === 'MergeCoins' ||
  FUNDING_CALLS.has(targetOf(command))

function isResultOf(argument: TxArgument | undefined, index: number): boolean {
  if (argument?.$kind === 'Result') return argument.Result === index
  return (
    argument?.$kind === 'NestedResult' &&
    argument.NestedResult[0] === index &&
    argument.NestedResult[1] === 0
  )
}

interface Step {
  index: number
  args: readonly TxArgument[]
  types: readonly string[]
}

/** The steps other than funding, held to exactly the targets expected, in order. */
function stepsOf(data: TxData, expected: readonly string[], what: string): Step[] {
  const steps = data.commands.flatMap((command, index) =>
    isFunding(command) ? [] : [{ command, index }]
  )
  const same =
    steps.length === expected.length &&
    steps.every(({ command }, i) => targetOf(command) === expected[i])
  if (!same) refused(`This is not ${what} you asked for: its steps are not the ones expected.`)
  return steps.map(({ command, index }) => ({
    index,
    args: command.$kind === 'MoveCall' ? command.MoveCall.arguments : [],
    types: command.$kind === 'MoveCall' ? command.MoveCall.typeArguments : [],
  }))
}

interface PlaceContext {
  manager: string
  side: string
  price: string
  quantity: string
  deposit: string
  expiry: string
}

function placeContext(context: Record<string, string> | undefined): PlaceContext {
  const figure = (key: string): string => {
    const value = context?.[key]
    if (value === undefined || !/^\d{1,20}$/.test(value)) {
      refused('This order lost track of what you asked for, so I stopped here.')
    }
    return value
  }
  const manager = context?.['manager']
  const side = context?.['side']
  if (manager === undefined || (side !== 'sell' && side !== 'buy')) {
    refused('This order lost track of what you asked for, so I stopped here.')
  }
  return {
    manager,
    side,
    price: figure('price'),
    quantity: figure('quantity'),
    deposit: figure('deposit'),
    expiry: figure('expiry'),
  }
}

function pureU64(read: ReadPure, argument: TxArgument | undefined): string | undefined {
  const bytes = read(argument)
  if (bytes === undefined) return undefined
  try {
    return bcs.u64().parse(bytes)
  } catch {
    return undefined
  }
}

/** The one coin split for the deposit, which must be exactly the amount the order holds. */
function assertDeposit(
  data: TxData,
  read: ReadPure,
  coin: TxArgument | undefined,
  amount: string
): void {
  const splits = data.commands.flatMap((command, index) =>
    command.$kind === 'SplitCoins' ? [{ split: command.SplitCoins, index }] : []
  )
  const [only] = splits
  if (
    splits.length !== 1 ||
    only === undefined ||
    only.split.amounts.length !== 1 ||
    !isResultOf(coin, only.index) ||
    pureU64(read, only.split.amounts[0]) !== amount
  ) {
    refused('This order deposits a different amount than it needs.')
  }
}

function assertPlace(
  data: TxData,
  read: ReadPure,
  readObject: ReadObject,
  context: Record<string, string> | undefined
): void {
  const want = placeContext(context)
  const isNew = want.manager === 'new'
  const steps = stepsOf(
    data,
    [
      ...(isNew ? [DEEPBOOK_CALLS.newManager] : []),
      DEEPBOOK_CALLS.deposit,
      DEEPBOOK_CALLS.proof,
      DEEPBOOK_CALLS.place,
      ...(isNew ? [DEEPBOOK_CALLS.register, DEEPBOOK_CALLS.share] : []),
    ],
    'the limit order'
  )
  const [created] = steps
  const afterNew = isNew ? steps.slice(1) : steps
  const [deposit, proof, place, register, share] = afterNew as [Step, Step, Step, Step?, Step?]

  const isManager = (argument: TxArgument | undefined): boolean =>
    isNew
      ? created !== undefined && isResultOf(argument, created.index)
      : readObject(argument) === normalizeSuiAddress(want.manager)
  const used = [deposit.args[0], proof.args[0], place.args[1], register?.args[0], share?.args[0]]
  const expected = isNew ? used : used.slice(0, 3)
  if (!expected.every(isManager)) {
    refused('This uses a different DeepBook account than the one it should.')
  }
  if (!isResultOf(place.args[2], proof.index)) {
    refused('This order was not proved by the account it trades from.')
  }

  const selling = want.side === 'sell'
  if (normalizeStructTag(deposit.types[0] ?? '') !== (selling ? DEEPBOOK_SUI : DEEPBOOK_USDC)) {
    refused('This order deposits the wrong token.')
  }
  assertDeposit(data, read, deposit.args[1], want.deposit)

  if (pureU64(read, place.args[6]) !== want.price) {
    refused('This order has a different price than the one you asked for.')
  }
  if (pureU64(read, place.args[7]) !== want.quantity) {
    refused('This order is for a different amount than the one you asked for.')
  }
  const isBid = read(place.args[8])
  if (isBid === undefined || isBid.length !== 1 || isBid[0] !== (selling ? 0 : 1)) {
    refused('This order is on the other side from the one you asked for.')
  }
  if (pureU64(read, place.args[10]) !== want.expiry) {
    refused('This order has a different expiry than the one it was built with.')
  }
}

function assertExit(data: TxData, readObject: ReadObject): void {
  const middle = data.commands.some((c) => targetOf(c) === DEEPBOOK_CALLS.cancel)
    ? DEEPBOOK_CALLS.cancel
    : DEEPBOOK_CALLS.settle
  if (data.commands.some(isFunding)) {
    refused('This is not the exit you asked for: its steps are not the ones expected.')
  }
  const [proof, pooled, first, second, transfer] = stepsOf(
    data,
    [
      DEEPBOOK_CALLS.proof,
      middle,
      DEEPBOOK_CALLS.withdrawAll,
      DEEPBOOK_CALLS.withdrawAll,
      'TransferObjects',
    ],
    'the exit'
  ) as [Step, Step, Step, Step, Step]

  const manager = readObject(proof.args[0])
  const sameManager =
    manager !== undefined &&
    readObject(pooled.args[1]) === manager &&
    readObject(first.args[0]) === manager &&
    readObject(second.args[0]) === manager
  if (!sameManager) refused('This uses a different DeepBook account than the one it should.')
  if (!isResultOf(pooled.args[2], proof.index)) {
    refused('This exit was not proved by the account it takes from.')
  }

  const coins = [first, second].map((step) => normalizeStructTag(step.types[0] ?? '')).sort()
  const objects = data.commands[transfer.index]?.TransferObjects?.objects ?? []
  const bothReturned =
    coins[0] !== coins[1] &&
    objects.length === 2 &&
    objects.some((o) => isResultOf(o, first.index)) &&
    objects.some((o) => isResultOf(o, second.index))
  if (!bothReturned) refused('This does not bring both tokens back to your wallet.')
}

/**
 * Passes only what this file would have built for this account: `assertPtbSafe` holds each call to
 * what it may do, and this holds the whole to its steps and figures. A placed order's figures are
 * compared with `context`, which shows only that the two agree, for the reason `limoAssertSafe` gives:
 * anyone holding the wallet's signature can broadcast these bytes directly. So only the tests of
 * `orderFigures` bind them to the person's words. An exit needs no context: a manager's money can only
 * go to the sender, and only its owner can sign for it.
 */
export function deepbookAssertSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string> | undefined
): void {
  assertPtbSafe(payload, account, DEEPBOOK_POLICY)
  if (payload.family !== 'sui') return
  const data = parsePtb(payload.transaction)
  const readObject = objectReaderFor(data)
  if (data.commands.some((c) => targetOf(c) === DEEPBOOK_CALLS.place)) {
    assertPlace(data, readerFor(data), readObject, context)
  } else {
    assertExit(data, readObject)
  }
}

export const DEEPBOOK_READS = {
  bookParams: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'pool_book_params'),
  tradeParams: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'pool_trade_params'),
  accountExists: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'account_exists'),
  account: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'account'),
  orders: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'get_account_order_details'),
  balance: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'balance'),
  managerIds: moveTarget(DEEPBOOK_PACKAGE, 'registry', 'get_balance_manager_ids'),
} as const
