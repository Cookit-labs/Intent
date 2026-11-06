import { ChainActionRefused, type NearTransaction, type SigningPayload } from '../types'
import { NEAR_ACCOUNT } from './account'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, TGAS, USDC_NEAR, USDT_NEAR, WRAP_NEAR } from './tokens'

/**
 * What a NEAR wallet may be asked to sign.
 *
 * A NEAR wallet sends what it signs, so the server sees only hashes afterwards.
 * These checks are the last server-side look before signing, and each one fails
 * closed. Anything not named here is refused, and that includes `ft_transfer_call`:
 * nothing in this app needs it, and it would run code on the receiving account.
 *
 * Bounds:
 * - `ft_transfer` attaches exactly 1 yoctoNEAR, as NEP-141 requires.
 * - Storage attaches exactly 0.00125 NEAR, the `storage_balance_bounds` minimum
 *   on every contract here.
 * - Gas is limited per method below, and to 300 TGas for a whole transaction.
 * - An exit attaches nothing but the 1 yoctoNEAR `intents.near` requires, and what it pays
 *   out goes to the signer: the staking contracts pay the caller, and a withdrawal
 *   from `intents.near` must name the signer as its receiver.
 *
 * What this cannot do: a 1Click deposit address comes from 1Click's API, and any
 * 64-hex account looks the same as another. This limits what leaves and in what
 * shape. It cannot prove the address belongs to the swap, or where funds land.
 */

export const INTENTS_CONTRACT = 'intents.near'
export const STORAGE_DEPOSIT_YOCTO = '1250000000000000000000'
export const MAX_TX_GAS = BigInt(300) * TGAS
export const STORAGE_GAS = BigInt(30) * TGAS
export const WRAP_GAS = BigInt(30) * TGAS
export const TRANSFER_GAS = BigInt(30) * TGAS
/** From `rnear-sdk`, which uses 200 TGas. */
export const RNEAR_STAKE_GAS = BigInt(200) * TGAS
/** Meta Pool's SDK uses 50 TGas. Doubled for margin, and unused gas comes back. */
export const METAPOOL_STAKE_GAS = BigInt(100) * TGAS
/** `rnear-sdk` uses 200 TGas for `unstake`, `unstake_all` and `withdraw_all`. */
export const RNEAR_EXIT_GAS = BigInt(200) * TGAS
/** The same margin as a Meta Pool stake. Unused gas comes back. */
export const METAPOOL_EXIT_GAS = BigInt(100) * TGAS
/** A generous limit: `ft_withdraw` spends what it needs on the transfer and its resolve. */
export const INTENTS_CALL_GAS = BigInt(100) * TGAS

/** Every 1Click deposit address seen on NEAR is a 64-hex implicit account. */
export const DEPOSIT_ADDRESS = /^[0-9a-f]{64}$/

export const SWAP_CONTRACTS: ReadonlySet<string> = new Set([WRAP_NEAR, USDC_NEAR, USDT_NEAR])

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

interface StakeVenueLimits {
  contract: string
  stakeGas: bigint
  allowStorage: boolean
  exitGas: bigint
  /** The one method that collects a finished unstake: it pays the caller everything that is ready. */
  claimMethod: string
}

/** One call, with nothing attached. Both contracts pay only their caller. */
function assertStakeExit(calls: Call[], limits: StakeVenueLimits): void {
  const exit = calls[0] as Call
  if (calls.length !== 1) refuse('it contains more than one step of an exit')
  assertGas(exit, limits.exitGas)
  if (exit.deposit !== BigInt(0)) refuse(`${exit.method} attaches money it should not`)
  if (exit.method === 'unstake') {
    const amount = exit.args['amount']
    if (!hasExactKeys(exit.args, ['amount']) || !isDigits(amount)) {
      refuse('unstake has unexpected arguments')
    }
    if (BigInt(amount) === BigInt(0)) refuse('the unstake moves nothing')
    return
  }
  if (Object.keys(exit.args).length !== 0) refuse(`${exit.method} has unexpected arguments`)
}

function assertStakeVenue(
  payload: SigningPayload,
  account: string,
  limits: StakeVenueLimits
): void {
  const transaction = readSingleTransaction(payload, account)
  if (transaction.receiverId !== limits.contract) {
    refuse(`${transaction.receiverId} is not this venue`)
  }
  const { calls } = transaction
  const last = calls[calls.length - 1] as Call
  if (['unstake', 'unstake_all', limits.claimMethod].includes(last.method)) {
    assertStakeExit(calls, limits)
    return
  }
  assertStake(calls, account, limits)
}

function assertStake(calls: Call[], account: string, limits: StakeVenueLimits): void {
  const { stakeGas, allowStorage } = limits
  const stake = calls[calls.length - 1] as Call
  if (stake.method !== 'deposit_and_stake') refuse('it does not end in a stake')
  assertGas(stake, stakeGas)
  if (Object.keys(stake.args).length !== 0) refuse('deposit_and_stake has unexpected arguments')
  if (stake.deposit === BigInt(0)) refuse('the stake attaches nothing')

  const before = calls.slice(0, -1)
  if (before.length > (allowStorage ? 1 : 0)) refuse('it contains more than a stake')
  for (const call of before) {
    if (call.method !== 'storage_deposit') refuse(`${call.method} is not allowed`)
    assertStorageDeposit(call, [account])
  }
}

/**
 * On `lst.rhealab.near`: [storage_deposit(you)?, deposit_and_stake], [unstake(amount)],
 * [unstake_all] or [withdraw_all].
 */
export function assertRnearSafe(payload: SigningPayload, account: string): void {
  assertStakeVenue(payload, account, {
    contract: RNEAR_CONTRACT,
    stakeGas: RNEAR_STAKE_GAS,
    allowStorage: true,
    exitGas: RNEAR_EXIT_GAS,
    claimMethod: 'withdraw_all',
  })
}

/**
 * On `meta-pool.near`: [deposit_and_stake], [unstake(amount)], [unstake_all] or
 * [withdraw_unstaked]. Its NEP-145 methods are empty stubs and a new account's storage
 * comes out of the first stake, so no storage call is allowed.
 */
export function assertMetapoolSafe(payload: SigningPayload, account: string): void {
  assertStakeVenue(payload, account, {
    contract: METAPOOL_CONTRACT,
    stakeGas: METAPOOL_STAKE_GAS,
    allowStorage: false,
    exitGas: METAPOOL_EXIT_GAS,
    claimMethod: 'withdraw_unstaked',
  })
}

function assertOneYocto(call: Call): void {
  assertGas(call, INTENTS_CALL_GAS)
  if (call.deposit !== BigInt(1)) refuse(`${call.method} does not attach exactly 1 yoctoNEAR`)
}

function positiveDigits(value: unknown): boolean {
  return isDigits(value) && BigInt(value) > BigInt(0)
}

/**
 * Selling a share out of a NEAR Intents balance: one [mt_transfer] on `intents.near` of exactly
 * this token to a 1Click deposit address. The contract moves it from the caller's own balance.
 */
export function assertIntentsSaleSafe(
  payload: SigningPayload,
  account: string,
  tokenId: string
): void {
  const { receiverId, calls } = readSingleTransaction(payload, account)
  if (receiverId !== INTENTS_CONTRACT) refuse(`${receiverId} is not NEAR Intents`)
  const sale = calls[0] as Call
  if (calls.length !== 1 || sale.method !== 'mt_transfer') refuse('it is not a single share sale')
  assertOneYocto(sale)
  if (!hasExactKeys(sale.args, ['receiver_id', 'token_id', 'amount'])) {
    refuse('the share sale has unexpected arguments')
  }
  const receiver = sale.args['receiver_id']
  if (typeof receiver !== 'string' || !DEPOSIT_ADDRESS.test(receiver) || receiver === account) {
    refuse('the share sale does not go to a deposit address')
  }
  if (sale.args['token_id'] !== tokenId) refuse('the share sale moves some other token')
  if (!positiveDigits(sale.args['amount'])) refuse('the share sale has a malformed amount')
}

/**
 * Bringing a token out of a NEAR Intents balance to the signer's own wallet: [ft_withdraw] on
 * `intents.near`, after a registration on that token if the signer has none. Both are separate
 * transactions because they go to different contracts.
 */
export function assertIntentsWithdrawalSafe(
  payload: SigningPayload,
  account: string,
  token: string
): void {
  if (payload.family !== 'near') refuse('it is not a NEAR transaction')
  if (!NEAR_ACCOUNT.test(account)) refuse('the account is not a NEAR account')
  const { transactions } = payload
  if (!Array.isArray(transactions) || (transactions.length !== 1 && transactions.length !== 2)) {
    refuse('it is not the expected number of transactions')
  }
  const steps = transactions.map(readTransaction)
  const { receiverId, calls } = steps[steps.length - 1] as NearTransaction & { calls: Call[] }
  if (receiverId !== INTENTS_CONTRACT) refuse(`${receiverId} is not NEAR Intents`)
  const withdrawal = calls[0] as Call
  if (calls.length !== 1 || withdrawal.method !== 'ft_withdraw') {
    refuse('it is not a single withdrawal')
  }
  assertOneYocto(withdrawal)
  if (!hasExactKeys(withdrawal.args, ['token', 'receiver_id', 'amount'])) {
    refuse('the withdrawal has unexpected arguments')
  }
  if (withdrawal.args['token'] !== token) refuse('the withdrawal moves some other token')
  if (withdrawal.args['receiver_id'] !== account) refuse('the withdrawal pays someone else')
  if (!positiveDigits(withdrawal.args['amount'])) refuse('the withdrawal has a malformed amount')

  if (steps.length === 2) {
    const first = steps[0] as NearTransaction & { calls: Call[] }
    if (first.receiverId !== token) refuse('the registration is on some other token')
    const registration = first.calls[0] as Call
    if (first.calls.length !== 1 || registration.method !== 'storage_deposit') {
      refuse('the step before the withdrawal is not a registration')
    }
    assertStorageDeposit(registration, [account])
  }
}
