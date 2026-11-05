import { ChainActionRefused, type NearTransaction, type SigningPayload } from '../types'
import { NEAR_ACCOUNT } from './account'
import {
  DCL_CONTRACT,
  DCL_EXIT_GAS,
  DCL_ORDER_GAS,
  DCL_POINT_DELTA,
  DCL_STORAGE_CAP,
  dclBuyToken,
  dclOrderMsg,
  isDclOrderId,
} from './rhea-dcl-rules'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, TGAS, USDC_NEAR, USDT_NEAR, WRAP_NEAR } from './tokens'

/**
 * What a NEAR wallet may be asked to sign.
 *
 * A NEAR wallet sends what it signs, so the server sees only hashes afterwards.
 * These checks are the last server-side look before signing, and each one fails
 * closed. Anything not named here is refused, and that includes `ft_transfer_call`,
 * which runs code on the receiving account. It has one exception, `assertDclOrderSafe`:
 * an order to `dclv2.ref-labs.near`, on one pinned pool, whose message is compared
 * whole with the one this app built. Every other check here still refuses it.
 *
 * Bounds:
 * - `ft_transfer` attaches exactly 1 yoctoNEAR, as NEP-141 requires.
 * - Storage attaches exactly 0.00125 NEAR, the `storage_balance_bounds` minimum on
 *   every token here. Rhea's DCL contract is the exception: its minimum is 0.5 NEAR,
 *   and `assertDclOrderSafe` holds it to that as a cap.
 * - A stake or wrap attaches at most 1,000 NEAR. Stablecoin transfers carry at most
 *   10,000 tokens. Dollar caps run earlier, in `prepareChainAction`. These ceilings
 *   only stop a payload far outside any trade that cap would pass.
 * - Gas is limited per method below, and to 300 TGas for a whole transaction.
 *
 * What this cannot do: a 1Click deposit address comes from 1Click's API, and any
 * 64-hex account looks the same as another. This limits what leaves and in what
 * shape. It cannot prove the address belongs to the swap, or where funds land.
 */

export const STORAGE_DEPOSIT_YOCTO = '1250000000000000000000'
export const MAX_NEAR_YOCTO = BigInt(1_000) * BigInt('1000000000000000000000000')
export const MAX_STABLE_UNITS = BigInt(10_000) * BigInt(1000000)
export const MAX_TX_GAS = BigInt(300) * TGAS
export const STORAGE_GAS = BigInt(30) * TGAS
export const WRAP_GAS = BigInt(30) * TGAS
export const TRANSFER_GAS = BigInt(30) * TGAS
/** From `rnear-sdk`, which uses 200 TGas. */
export const RNEAR_STAKE_GAS = BigInt(200) * TGAS
/** Meta Pool's SDK uses 50 TGas. Doubled for margin, and unused gas comes back. */
export const METAPOOL_STAKE_GAS = BigInt(100) * TGAS

/** Every 1Click deposit address seen on NEAR is a 64-hex implicit account. */
export const DEPOSIT_ADDRESS = /^[0-9a-f]{64}$/

const SWAP_CONTRACTS = new Set([WRAP_NEAR, USDC_NEAR, USDT_NEAR])

function refuse(reason: string): never {
  throw new ChainActionRefused(
    `This transaction was stopped before signing because ${reason}. Nothing was signed or sent.`
  )
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function isDigits(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

interface Call {
  method: string
  args: Record<string, unknown>
  gas: bigint
  deposit: bigint
}

/** The one transaction a venue may send, read strictly. Unknown shapes are refused. */
function readSingleTransaction(
  payload: SigningPayload,
  account: string
): NearTransaction & {
  calls: Call[]
} {
  if (payload.family !== 'near') refuse('it is not a NEAR transaction')
  if (!NEAR_ACCOUNT.test(account)) refuse('the account is not a NEAR account')
  const { transactions } = payload
  if (!Array.isArray(transactions) || transactions.length !== 1) {
    refuse('it is not exactly one transaction')
  }
  return readTransaction(transactions[0] as NearTransaction)
}

function readTransaction(transaction: NearTransaction): NearTransaction & { calls: Call[] } {
  if (!hasExactKeys(transaction, ['receiverId', 'actions'])) {
    refuse('the transaction carries unexpected fields')
  }
  if (!Array.isArray(transaction.actions) || transaction.actions.length === 0) {
    refuse('the transaction has no actions')
  }

  let totalGas = BigInt(0)
  const calls = transaction.actions.map((action): Call => {
    if (action.type !== 'FunctionCall' || !hasExactKeys(action, ['type', 'params'])) {
      refuse('it contains something other than a contract call')
    }
    const { params } = action
    if (!hasExactKeys(params, ['methodName', 'args', 'gas', 'deposit'])) {
      refuse('a contract call carries unexpected fields')
    }
    if (typeof params.args !== 'object' || params.args === null || Array.isArray(params.args)) {
      refuse('a contract call has malformed arguments')
    }
    if (!isDigits(params.gas) || !isDigits(params.deposit)) {
      refuse('a contract call has a malformed gas or deposit amount')
    }
    const gas = BigInt(params.gas)
    if (gas === BigInt(0)) refuse('a contract call has no gas')
    totalGas += gas
    return {
      method: params.methodName,
      args: params.args,
      gas,
      deposit: BigInt(params.deposit),
    }
  })
  if (totalGas > MAX_TX_GAS) refuse('it asks for more gas than this app allows')
  return { ...transaction, calls }
}

function assertGas(call: Call, limit: bigint): void {
  if (call.gas > limit) refuse(`${call.method} asks for more gas than this app allows`)
}

function assertStorageDeposit(call: Call, allowedAccounts: readonly string[]): void {
  assertGas(call, STORAGE_GAS)
  if (call.deposit !== BigInt(STORAGE_DEPOSIT_YOCTO)) {
    refuse('a storage payment is not the expected 0.00125 NEAR')
  }
  if (
    !hasExactKeys(call.args, ['account_id', 'registration_only']) ||
    call.args['registration_only'] !== true
  ) {
    refuse('a storage payment has unexpected arguments')
  }
  const target = call.args['account_id']
  if (typeof target !== 'string' || !allowedAccounts.includes(target)) {
    refuse('a storage payment is for an unexpected account')
  }
}

/**
 * A 1Click deposit: one transaction to one token contract, ending in the single
 * `ft_transfer` that pays the deposit address.
 *
 *   USDC or USDT: [storage_deposit(deposit address)?, ft_transfer]
 *   NEAR on wrap.near: [storage_deposit(you)?, near_deposit, storage_deposit(deposit address)?, ft_transfer]
 *
 * Actions in one transaction run as one receipt, so if the transfer fails the wrap
 * and any storage payment are reverted and refunded too.
 */
export function assertOneClickSafe(payload: SigningPayload, account: string): void {
  assertTokenTransferSafe(payload, account, DEPOSIT_ADDRESS)
}

/**
 * The same check, with the shape the transfer's receiver must have. Only for a caller that binds
 * the exact receiver itself afterwards, as a send does.
 */
export function assertTokenTransferSafe(
  payload: SigningPayload,
  account: string,
  receiver: RegExp
): void {
  const transaction = readSingleTransaction(payload, account)
  if (!SWAP_CONTRACTS.has(transaction.receiverId)) {
    refuse(`${transaction.receiverId} is not a token this app trades`)
  }
  const { calls } = transaction
  const transfer = calls[calls.length - 1] as Call
  if (transfer.method !== 'ft_transfer') refuse('it does not end in a token transfer')

  assertGas(transfer, TRANSFER_GAS)
  if (transfer.deposit !== BigInt(1))
    refuse('the token transfer does not attach exactly 1 yoctoNEAR')
  if (!hasExactKeys(transfer.args, ['receiver_id', 'amount'])) {
    refuse('the token transfer has unexpected arguments')
  }
  const depositAddress = transfer.args['receiver_id']
  const amountText = transfer.args['amount']
  if (typeof depositAddress !== 'string' || !receiver.test(depositAddress)) {
    refuse('the token transfer does not go to a deposit address')
  }
  if (depositAddress === account) refuse('the token transfer pays your own account')
  if (!isDigits(amountText)) refuse('the token transfer has a malformed amount')
  const amount = BigInt(amountText)
  if (amount === BigInt(0)) refuse('the token transfer moves nothing')
  const isWrapped = transaction.receiverId === WRAP_NEAR
  if (amount > (isWrapped ? MAX_NEAR_YOCTO : MAX_STABLE_UNITS)) {
    refuse('the token transfer is larger than this app allows')
  }

  const before = calls.slice(0, -1)
  const wrapIndex = before.findIndex((c) => c.method === 'near_deposit')
  before.forEach((call, index) => {
    if (call.method === 'storage_deposit') {
      // Your own storage is only ever paid for just before wrapping.
      const selfAllowed = isWrapped && wrapIndex > index
      assertStorageDeposit(call, selfAllowed ? [account] : [depositAddress])
      return
    }
    if (call.method === 'near_deposit') {
      if (!isWrapped) refuse('near_deposit is only allowed on wrap.near')
      if (index !== wrapIndex) refuse('it wraps NEAR more than once')
      assertGas(call, WRAP_GAS)
      if (Object.keys(call.args).length !== 0) refuse('near_deposit has unexpected arguments')
      if (call.deposit !== amount) refuse('the amount wrapped is not the amount sent')
      return
    }
    refuse(`${call.method} is not allowed`)
  })
  if (isWrapped && wrapIndex === -1) refuse('it sends wNEAR without wrapping it first')

  const paidFor = before
    .filter((c) => c.method === 'storage_deposit')
    .map((c) => c.args['account_id'])
  if (new Set(paidFor).size !== paidFor.length) refuse('it pays for the same storage twice')
}

function assertStake(
  payload: SigningPayload,
  account: string,
  contract: string,
  stakeGas: bigint,
  allowStorage: boolean
): void {
  const transaction = readSingleTransaction(payload, account)
  if (transaction.receiverId !== contract) refuse(`${transaction.receiverId} is not this venue`)
  const { calls } = transaction
  const stake = calls[calls.length - 1] as Call
  if (stake.method !== 'deposit_and_stake') refuse('it does not end in a stake')
  assertGas(stake, stakeGas)
  if (Object.keys(stake.args).length !== 0) refuse('deposit_and_stake has unexpected arguments')
  if (stake.deposit === BigInt(0)) refuse('the stake attaches nothing')
  if (stake.deposit > MAX_NEAR_YOCTO) refuse('the stake is larger than this app allows')

  const before = calls.slice(0, -1)
  if (before.length > (allowStorage ? 1 : 0)) refuse('it contains more than a stake')
  for (const call of before) {
    if (call.method !== 'storage_deposit') refuse(`${call.method} is not allowed`)
    assertStorageDeposit(call, [account])
  }
}

/** [storage_deposit(you)?, deposit_and_stake] on `lst.rhealab.near`. */
export function assertRnearSafe(payload: SigningPayload, account: string): void {
  assertStake(payload, account, RNEAR_CONTRACT, RNEAR_STAKE_GAS, true)
}

/**
 * [deposit_and_stake] on `meta-pool.near`. Its NEP-145 methods are empty stubs and
 * a new account's storage comes out of the first stake, so no storage call is allowed.
 */
export function assertMetapoolSafe(payload: SigningPayload, account: string): void {
  assertStake(payload, account, METAPOOL_CONTRACT, METAPOOL_STAKE_GAS, false)
}

export interface DclOrderExpected {
  /** The NEP-141 contract the order sells: `wrap.near` or USDC. */
  sellToken: string
  /** Base units. */
  amount: string
  point: number
}

/** Storage for yourself, on Rhea, up to the cap. The amount is its own `storage_balance_bounds`. */
function assertDclStorage(call: Call, account: string): void {
  assertGas(call, STORAGE_GAS)
  if (call.deposit === BigInt(0) || call.deposit > DCL_STORAGE_CAP) {
    refuse('the storage payment on Rhea is outside what this app allows')
  }
  if (
    !hasExactKeys(call.args, ['account_id', 'registration_only']) ||
    call.args['account_id'] !== account ||
    call.args['registration_only'] !== true
  ) {
    refuse('the storage payment on Rhea has unexpected arguments')
  }
}

/** Storage only, each on its own transaction, in the order the order needs it and at most once. */
function assertDclSetup(
  transactions: (NearTransaction & { calls: Call[] })[],
  account: string,
  sellToken: string,
  buyToken: string
): void {
  const allowed = [DCL_CONTRACT, buyToken, ...(sellToken === WRAP_NEAR ? [WRAP_NEAR] : [])]
  let next = 0
  for (const { receiverId, calls } of transactions) {
    const at = allowed.indexOf(receiverId, next)
    if (at === -1) refuse(`${receiverId} takes no storage payment for this order`)
    next = at + 1
    const [call] = calls
    if (calls.length !== 1 || call?.method !== 'storage_deposit') {
      refuse('a setup transaction does more than pay for storage')
    }
    if (receiverId === DCL_CONTRACT) assertDclStorage(call, account)
    else assertStorageDeposit(call, [account])
  }
}

/** [near_deposit, ft_transfer_call] on `wrap.near`, or [ft_transfer_call] on USDC. */
function assertDclPlacement(
  transaction: NearTransaction & { calls: Call[] },
  expected: DclOrderExpected,
  buyToken: string
): void {
  const { receiverId, calls } = transaction
  const isWrapped = receiverId === WRAP_NEAR
  if (receiverId !== expected.sellToken) refuse('the order sells a different token')
  if (calls.length !== (isWrapped ? 2 : 1)) refuse('the order carries the wrong number of calls')

  const transfer = calls[calls.length - 1] as Call
  if (transfer.method !== 'ft_transfer_call') refuse('it does not end in the order')
  assertGas(transfer, DCL_ORDER_GAS)
  if (transfer.deposit !== BigInt(1)) refuse('the order does not attach exactly 1 yoctoNEAR')
  if (!hasExactKeys(transfer.args, ['receiver_id', 'amount', 'msg'])) {
    refuse('the order has unexpected arguments')
  }
  if (transfer.args['receiver_id'] !== DCL_CONTRACT) refuse('the order does not go to Rhea')

  const amountText = transfer.args['amount']
  if (amountText !== expected.amount || !isDigits(amountText)) {
    refuse('the order is not for the amount that was asked')
  }
  const amount = BigInt(amountText)
  if (amount === BigInt(0)) refuse('the order sells nothing')
  if (amount > (isWrapped ? MAX_NEAR_YOCTO : MAX_STABLE_UNITS)) {
    refuse('the order is larger than this app allows')
  }
  // Whole text against whole text: pool, buy token, point, client id and any extra key all at once.
  if (transfer.args['msg'] !== dclOrderMsg(buyToken, expected.point)) {
    refuse('the order is not the one that was asked for')
  }

  if (!isWrapped) return
  const wrap = calls[0] as Call
  if (wrap.method !== 'near_deposit') refuse(`${wrap.method} is not allowed`)
  assertGas(wrap, WRAP_GAS)
  if (Object.keys(wrap.args).length !== 0) refuse('near_deposit has unexpected arguments')
  if (wrap.deposit !== amount) refuse('the amount wrapped is not the amount sold')
}

/**
 * The one place `ft_transfer_call` is allowed. A payload is either setup, storage and nothing else,
 * or the order alone. Never both: a wallet given several transactions promises neither their order
 * nor to stop after one fails, so an order signed beside its storage could land without it, and fail.
 */
export function assertDclOrderSafe(
  payload: SigningPayload,
  account: string,
  expected: DclOrderExpected
): void {
  if (payload.family !== 'near') refuse('it is not a NEAR transaction')
  if (!NEAR_ACCOUNT.test(account)) refuse('the account is not a NEAR account')
  const buyToken = dclBuyToken(expected.sellToken)
  if (buyToken === undefined) refuse(`${expected.sellToken} is not a token this order sells`)
  if (!Number.isSafeInteger(expected.point) || expected.point % DCL_POINT_DELTA !== 0) {
    refuse('the order has no usable price point')
  }
  const { transactions } = payload
  if (!Array.isArray(transactions) || transactions.length === 0) {
    refuse('it has no transactions')
  }
  const read = transactions.map(readTransaction)
  if (read.some((t) => t.calls.some((c) => c.method !== 'storage_deposit'))) {
    if (read.length !== 1) refuse('the order is not alone in what is being signed')
    assertDclPlacement(read[0] as NearTransaction & { calls: Call[] }, expected, buyToken)
    return
  }
  assertDclSetup(read, account, expected.sellToken, buyToken)
}

/** `cancel_order` on Rhea for this one order on the pinned pool, with no deposit. */
export function assertDclExitSafe(payload: SigningPayload, account: string, orderId: string): void {
  const transaction = readSingleTransaction(payload, account)
  if (transaction.receiverId !== DCL_CONTRACT) refuse(`${transaction.receiverId} is not Rhea`)
  if (!isDclOrderId(orderId)) refuse('that is not an order on the pool this app trades')
  const [call] = transaction.calls
  if (transaction.calls.length !== 1 || call?.method !== 'cancel_order') {
    refuse('it does more than change one order')
  }
  assertGas(call, DCL_EXIT_GAS)
  if (call.deposit !== BigInt(0)) refuse('changing an order should attach nothing')
  if (!hasExactKeys(call.args, ['order_id', 'amount'])) {
    refuse('changing an order has unexpected arguments')
  }
  if (call.args['order_id'] !== orderId) refuse('it changes a different order')
  if (!isDigits(call.args['amount'])) refuse('changing an order has a malformed amount')
}

/**
 * Rhea's `assertSafe`, holding a payload to what `prepare` issued. Only ever runs on what this server
 * just built: NEAR wallets send for themselves, so the submit route has no bytes to bring back here.
 */
export function assertRheaDclSafe(
  payload: SigningPayload,
  account: string,
  context?: Record<string, string> | undefined
): void {
  const orderId = context?.['orderId']
  if (orderId !== undefined) {
    assertDclExitSafe(payload, account, orderId)
    return
  }
  const sellToken = context?.['sellToken']
  const amount = context?.['amount']
  const point = context?.['point']
  if (
    sellToken === undefined ||
    !isDigits(amount) ||
    point === undefined ||
    !/^-?\d+$/.test(point)
  ) {
    refuse('it does not say what it was built for')
  }
  assertDclOrderSafe(payload, account, { sellToken, amount, point: Number(point) })
}
