import { ChainActionRefused, type SigningPayload } from '../types'
import { NEAR_ACCOUNT } from './account'
import { MAX_TX_GAS, STORAGE_DEPOSIT_YOCTO, STORAGE_GAS, WRAP_GAS } from './safety'
import { TGAS, USDC_NEAR, USDT_NEAR, WRAP_NEAR } from './tokens'

/**
 * What a wallet may be asked to sign for Rhea. `near/safety.ts` refuses `ft_transfer_call`
 * everywhere, because it runs code on the receiving account. This file is the one exception, and
 * only for two pinned contracts and exact messages. Anything not named here is refused.
 *
 * A Rhea DEX swap is an "instant swap": `ft_transfer_call` to the exchange, whose message names the
 * pools. Read from the contract: with no `swap_out_recipient` and no `client_echo`, what comes out
 * is sent to the account that sent the tokens, and if the message can't be met the tokens return.
 * So those two fields are what could send the money elsewhere, and neither may appear.
 */

export const RHEA_DEX = 'v2.ref-finance.near'
export const RHEA_LEND = 'contract.main.burrow.near'
export const RHEA_PRICE_ORACLE = 'aggregate-oracle.near'

/** `storage_balance_bounds` on Rhea Lend: 10,000 bytes. */
export const RHEA_LEND_STORAGE_YOCTO = '100000000000000000000000'
/** Below the 300 TGas cap once a wrap and a storage payment share the transaction. */
export const RHEA_SWAP_GAS = BigInt(240) * TGAS
/** Rhea's own front end uses 100 TGas on a deposit, a repay and an `execute`, 300 with prices. */
export const RHEA_LEND_TOKEN_GAS = BigInt(100) * TGAS
export const RHEA_EXECUTE_GAS = BigInt(100) * TGAS
export const RHEA_EXECUTE_PYTH_GAS = BigInt(300) * TGAS
export const RHEA_EXIT_GAS = BigInt(100) * TGAS

/** Rhea Lend counts USDC and USDT in 18 decimal places. `extra_decimals` in each asset's config. */
export const RHEA_EXTRA_DECIMALS: Readonly<Record<string, number>> = {
  [WRAP_NEAR]: 0,
  [USDC_NEAR]: 12,
  [USDT_NEAR]: 12,
}

const LISTED: ReadonlySet<string> = new Set([WRAP_NEAR, USDC_NEAR, USDT_NEAR])
const STABLES: ReadonlySet<string> = new Set([USDC_NEAR, USDT_NEAR])

/**
 * The only pools a swap may touch, each with the listed tokens it trades. Taken from a scan of all
 * 9,006 pools as the deepest for each pair. The chain is read again for these before every use.
 */
export const RHEA_POOLS: Readonly<Record<number, readonly string[]>> = {
  4512: [USDC_NEAR, WRAP_NEAR],
  5515: [WRAP_NEAR, USDC_NEAR],
  6063: [WRAP_NEAR, USDT_NEAR],
  6416: [USDT_NEAR, USDC_NEAR],
  4179: [USDT_NEAR, USDC_NEAR],
}

/** At most two hops, since each one can only be held to a minimum at the end of the route. */
const MAX_HOPS = 2
/** Two stablecoins are worth about the same, so a minimum far below that is not a minimum. */
const STABLE_FLOOR_BPS = BigInt(9500)

function refuse(reason: string): never {
  throw new ChainActionRefused(
    `This transaction was stopped before signing because ${reason}. Nothing was signed or sent.`
  )
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
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

interface ReadTransaction {
  receiverId: string
  calls: Call[]
}

function readTransactions(
  payload: SigningPayload,
  account: string,
  most: number
): ReadTransaction[] {
  if (payload.family !== 'near') refuse('it is not a NEAR transaction')
  if (!NEAR_ACCOUNT.test(account)) refuse('the account is not a NEAR account')
  const { transactions } = payload
  if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > most) {
    refuse('it is not the expected number of transactions')
  }
  return transactions.map((transaction) => {
    if (!hasExactKeys(transaction, ['receiverId', 'actions'])) {
      refuse('a transaction carries unexpected fields')
    }
    if (!Array.isArray(transaction.actions) || transaction.actions.length === 0) {
      refuse('a transaction has no actions')
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
      return { method: params.methodName, args: params.args, gas, deposit: BigInt(params.deposit) }
    })
    if (totalGas > MAX_TX_GAS) refuse('it asks for more gas than this app allows')
    return { receiverId: transaction.receiverId, calls }
  })
}

function assertGas(call: Call, limit: bigint): void {
  if (call.gas > limit) refuse(`${call.method} asks for more gas than this app allows`)
}

function assertOneYocto(call: Call): void {
  if (call.deposit !== BigInt(1)) refuse(`${call.method} does not attach exactly 1 yoctoNEAR`)
}

function assertOwnStorage(call: Call, account: string, deposit: string): void {
  if (call.method !== 'storage_deposit') refuse(`${call.method} is not allowed`)
  assertGas(call, STORAGE_GAS)
  if (call.deposit !== BigInt(deposit)) refuse('a storage payment is not the expected amount')
  if (
    !hasExactKeys(call.args, ['account_id', 'registration_only']) ||
    call.args['registration_only'] !== true
  ) {
    refuse('a storage payment has unexpected arguments')
  }
  if (call.args['account_id'] !== account) refuse('a storage payment is for another account')
}

function isRegistration(transaction: ReadTransaction): boolean {
  return transaction.calls.length === 1 && transaction.calls[0]?.method === 'storage_deposit'
}

function assertTokenRegistration(transaction: ReadTransaction, account: string): void {
  if (!LISTED.has(transaction.receiverId)) refuse(`${transaction.receiverId} is not a listed token`)
  assertOwnStorage(transaction.calls[0] as Call, account, STORAGE_DEPOSIT_YOCTO)
}

function assertUnwrap(transaction: ReadTransaction): void {
  if (transaction.receiverId !== WRAP_NEAR || transaction.calls.length !== 1) {
    refuse('an unwrap is not a single call on wrap.near')
  }
  const call = transaction.calls[0] as Call
  assertGas(call, WRAP_GAS)
  assertOneYocto(call)
  if (!hasExactKeys(call.args, ['amount']) || !isDigits(call.args['amount'])) {
    refuse('near_withdraw has unexpected arguments')
  }
  if (BigInt(call.args['amount']) === BigInt(0)) refuse('near_withdraw moves nothing')
}

/**
 * What runs before an `ft_transfer_call` in its transaction, which is a wrap of exactly that amount
 * and nothing else. Actions in one transaction succeed or revert together.
 */
function assertWrapPrefix(
  transaction: ReadTransaction,
  account: string,
  amount: bigint,
  transferGas: bigint
): void {
  const { receiverId, calls } = transaction
  const transfer = calls[calls.length - 1] as Call
  assertGas(transfer, transferGas)
  assertOneYocto(transfer)
  const before = calls.slice(0, -1)
  if (receiverId !== WRAP_NEAR) {
    if (before.length > 0) refuse('it does more than the token transfer')
    return
  }
  const wrap = before[before.length - 1]
  if (wrap?.method !== 'near_deposit') refuse('it spends wNEAR without wrapping NEAR first')
  assertGas(wrap, WRAP_GAS)
  if (Object.keys(wrap.args).length !== 0) refuse('near_deposit has unexpected arguments')
  if (wrap.deposit !== amount) refuse('the amount wrapped is not the amount sent')
  const rest = before.slice(0, -1)
  if (rest.length > 1) refuse('it does more than a wrap and the token transfer')
  for (const call of rest) assertOwnStorage(call, account, STORAGE_DEPOSIT_YOCTO)
}

/** The message must be written the one way this app writes it, so no other parser reads it apart. */
function parseCanonical(msg: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(msg)
  } catch {
    refuse('its message is not readable')
  }
  if (JSON.stringify(parsed) !== msg) refuse('its message is not in the expected form')
  if (typeof parsed !== 'object' || parsed === null)
    refuse('its message is not in the expected form')
  return parsed
}

/**
 * Reads a swap message and returns the token it ends in. Every hop is on a pinned pool, joins the
 * one before it, and starts from exactly what is sent. The last hop holds a real minimum.
 */
function assertSwapMessage(msg: unknown, tokenIn: string, amount: bigint): string {
  if (typeof msg !== 'string' || msg === '') refuse('the swap has no message')
  const parsed = parseCanonical(msg) as { actions?: unknown; skip_unwrap_near?: unknown }

  const hops = parsed.actions
  if (!Array.isArray(hops) || hops.length === 0 || hops.length > MAX_HOPS) {
    refuse('the swap does not have one or two steps')
  }
  let from = tokenIn
  const seen = new Set<number>()
  let minimum = BigInt(0)
  hops.forEach((hop: Record<string, unknown>, index) => {
    const first = index === 0
    const keys = ['pool_id', 'token_in', 'token_out', 'min_amount_out']
    if (!hasExactKeys(hop, first ? [...keys, 'amount_in'] : keys)) {
      refuse('a swap step carries unexpected fields')
    }
    const pool = hop['pool_id']
    const tokens = typeof pool === 'number' ? RHEA_POOLS[pool] : undefined
    if (typeof pool !== 'number' || tokens === undefined || seen.has(pool)) {
      refuse('a swap step uses a pool this app has not checked')
    }
    seen.add(pool)
    const { token_in: stepIn, token_out: stepOut, min_amount_out: stepMin } = hop
    if (stepIn !== from) refuse('the swap steps do not join up')
    if (typeof stepOut !== 'string' || !tokens.includes(stepOut) || stepOut === stepIn) {
      refuse('a swap step trades a token its pool does not hold')
    }
    if (!isDigits(stepMin)) refuse('a swap step has a malformed minimum')
    if (first && (!isDigits(hop['amount_in']) || BigInt(hop['amount_in']) !== amount)) {
      refuse('the amount swapped is not the amount sent')
    }
    minimum = BigInt(stepMin)
    from = stepOut
  })

  const tokenOut = from
  if (tokenOut === tokenIn) refuse('the swap ends in the token it started with')
  if (minimum === BigInt(0)) refuse('the swap has no minimum to receive')
  if (
    STABLES.has(tokenIn) &&
    STABLES.has(tokenOut) &&
    minimum * BigInt(10_000) < amount * STABLE_FLOOR_BPS
  ) {
    refuse('the swap accepts far too little back')
  }

  // Native NEAR needs no registration and can't bounce, so that is how NEAR comes out.
  const expected = tokenOut === WRAP_NEAR ? ['actions', 'skip_unwrap_near'] : ['actions']
  if (!hasExactKeys(parsed, expected)) refuse('the swap message carries unexpected fields')
  if (tokenOut === WRAP_NEAR && parsed.skip_unwrap_near !== false) {
    refuse('the swap would not hand back NEAR')
  }
  return tokenOut
}

function assertSwapTransaction(transaction: ReadTransaction, account: string): string {
  const { receiverId, calls } = transaction
  if (!LISTED.has(receiverId)) refuse(`${receiverId} is not a listed token`)
  const transfer = calls[calls.length - 1] as Call
  if (transfer.method !== 'ft_transfer_call') refuse('it does not end in the swap')
  if (!hasExactKeys(transfer.args, ['receiver_id', 'amount', 'msg'])) {
    refuse('the swap has unexpected arguments')
  }
  if (transfer.args['receiver_id'] !== RHEA_DEX) refuse('the swap does not go to Rhea DEX')
  const amountText = transfer.args['amount']
  if (!isDigits(amountText) || BigInt(amountText) === BigInt(0)) {
    refuse('the swap has a malformed amount')
  }
  const amount = BigInt(amountText)
  assertWrapPrefix(transaction, account, amount, RHEA_SWAP_GAS)
  return assertSwapMessage(transfer.args['msg'], receiverId, amount)
}

function assertDexExit(transaction: ReadTransaction): void {
  if (transaction.calls.length !== 1) refuse('it does more than one thing on Rhea DEX')
  const call = transaction.calls[0] as Call
  assertGas(call, RHEA_EXIT_GAS)
  assertOneYocto(call)
  const token = call.args['token_id']
  if (typeof token !== 'string' || !LISTED.has(token)) refuse('it takes out an unlisted token')
  if (call.method === 'claim_lostfound') {
    if (!hasExactKeys(call.args, ['token_id'])) refuse('the claim has unexpected arguments')
    return
  }
  if (call.method !== 'withdraw') refuse(`${call.method} is not allowed`)
  // `withdraw` has no recipient: it pays whoever signed. Amount 0 is the contract's "all of it".
  if (!isDigits(call.args['amount'])) refuse('the withdrawal has a malformed amount')
  const expected =
    token === WRAP_NEAR ? ['token_id', 'amount', 'skip_unwrap_near'] : ['token_id', 'amount']
  if (!hasExactKeys(call.args, expected)) refuse('the withdrawal has unexpected arguments')
  if (token === WRAP_NEAR && call.args['skip_unwrap_near'] !== false) {
    refuse('the withdrawal would not hand back NEAR')
  }
}

/**
 * A swap: [storage_deposit(you) on the token coming out]?, then one transaction on the token going
 * in: [storage_deposit(you)?, near_deposit, ft_transfer_call] for NEAR, or [ft_transfer_call].
 *
 * Getting tokens back out of Rhea: any of [storage_deposit(you)], [withdraw], [claim_lostfound] and
 * [near_withdraw], none of which can name anyone but the signer.
 */
export function assertRheaDexSafe(payload: SigningPayload, account: string): void {
  const transactions = readTransactions(payload, account, 3)
  const last = transactions[transactions.length - 1] as ReadTransaction
  const swaps = transactions.filter((t) => t.calls.some((c) => c.method === 'ft_transfer_call'))
  if (swaps.length > 1) refuse('it contains more than one swap')

  if (swaps.length === 1) {
    if (swaps[0] !== last) refuse('the swap is not the last transaction')
    const tokenOut = assertSwapTransaction(last, account)
    const before = transactions.slice(0, -1)
    if (before.length > 1) refuse('it does more than register you and swap')
    for (const transaction of before) {
      if (!isRegistration(transaction)) refuse('it does more than register you and swap')
      if (transaction.receiverId !== tokenOut) refuse('it registers you on the wrong token')
      assertTokenRegistration(transaction, account)
    }
    return
  }

  for (const transaction of transactions) {
    if (transaction.receiverId === RHEA_DEX) assertDexExit(transaction)
    else if (isRegistration(transaction)) assertTokenRegistration(transaction, account)
    else assertUnwrap(transaction)
  }
}

function assertAssetAmount(value: unknown, keys: readonly string[]): string {
  if (!hasExactKeys(value, keys)) refuse('a Rhea Lend step carries unexpected fields')
  const fields = value as Record<string, unknown>
  const token = fields['token_id']
  if (typeof token !== 'string' || !LISTED.has(token))
    refuse('a Rhea Lend step names another token')
  for (const key of keys) {
    if (key !== 'token_id' && !isDigits(fields[key])) refuse('a Rhea Lend step has a bad amount')
  }
  return token
}

function stepOf(action: unknown): { name: string; body: unknown } {
  if (typeof action !== 'object' || action === null || Object.keys(action).length !== 1) {
    refuse('a Rhea Lend step is malformed')
  }
  const [name, body] = Object.entries(action)[0] as [string, unknown]
  return { name, body }
}

function assertWithdrawStep(step: { name: string; body: unknown }): string {
  if (step.name !== 'Withdraw') refuse(`${step.name} is not allowed`)
  const keys = Object.keys((step.body ?? {}) as object).includes('max_amount')
    ? ['token_id', 'max_amount']
    : ['token_id']
  return assertAssetAmount(step.body, keys)
}

/**
 * The only steps this app sends. `Withdraw` has no recipient: it pays the account that signed.
 * Everything else the contract offers is refused, which includes `ClientEchoWithdraw`, liquidating
 * someone else, margin and LP positions, and `simple_withdraw`, which can name a recipient.
 *
 *   execute: [Withdraw]
 *   execute_with_pyth: [IncreaseCollateral...], or [DecreaseCollateral, Withdraw], or [Borrow, Withdraw]
 */
function assertLendExecute(transaction: ReadTransaction): string | undefined {
  if (transaction.calls.length !== 1) refuse('it does more than one thing on Rhea Lend')
  const call = transaction.calls[0] as Call
  assertOneYocto(call)
  if (!hasExactKeys(call.args, ['actions'])) refuse('the call has unexpected arguments')
  const actions = call.args['actions']
  if (!Array.isArray(actions) || actions.length === 0) refuse('the call has no steps')
  const steps = actions.map(stepOf)
  const first = steps[0] as { name: string; body: unknown }

  if (call.method === 'execute') {
    assertGas(call, RHEA_EXECUTE_GAS)
    if (steps.length !== 1) refuse('a call without prices may only withdraw')
    return assertWithdrawStep(first)
  }
  if (call.method !== 'execute_with_pyth') refuse(`${call.method} is not allowed`)
  assertGas(call, RHEA_EXECUTE_PYTH_GAS)

  if (first.name === 'IncreaseCollateral') {
    const tokens = steps.map((step) => {
      if (step.name !== 'IncreaseCollateral') refuse(`${step.name} is not allowed here`)
      return assertAssetAmount(step.body, ['token_id'])
    })
    if (new Set(tokens).size !== tokens.length) refuse('it names a token twice')
    return undefined
  }
  if (steps.length !== 2) refuse('it has an unexpected number of steps')
  const withdraw = steps[1] as { name: string; body: unknown }
  const withdrawn = assertWithdrawStep(withdraw)

  if (first.name === 'Borrow') {
    const borrowed = assertAssetAmount(first.body, ['token_id', 'amount'])
    const taken = (withdraw.body as { max_amount?: unknown }).max_amount
    if (borrowed !== withdrawn || taken !== (first.body as { amount?: unknown }).amount) {
      refuse('the amount taken out is not the amount borrowed')
    }
    return withdrawn
  }
  if (first.name !== 'DecreaseCollateral') refuse(`${first.name} is not allowed`)
  const keys = Object.keys((first.body ?? {}) as object).includes('amount')
    ? ['token_id', 'amount']
    : ['token_id']
  if (assertAssetAmount(first.body, keys) !== withdrawn) {
    refuse('the collateral released is not the token withdrawn')
  }
  return withdrawn
}

/** A repay holds to what was sent, so it can't reach into anything else held there. */
function assertLendMessage(msg: unknown, token: string, amount: bigint): void {
  if (msg === '') return
  if (typeof msg !== 'string') refuse('the deposit has a malformed message')
  const parsed = parseCanonical(msg) as { Execute?: { actions?: unknown } }
  if (!hasExactKeys(parsed, ['Execute']) || !hasExactKeys(parsed.Execute, ['actions'])) {
    refuse('the deposit message is not a repayment')
  }
  const actions = parsed.Execute?.actions
  if (!Array.isArray(actions) || actions.length !== 1) refuse('the message does more than repay')
  const step = stepOf(actions[0])
  if (step.name !== 'Repay') refuse(`${step.name} is not allowed`)
  if (assertAssetAmount(step.body, ['token_id', 'max_amount']) !== token) {
    refuse('the repayment names another token')
  }
  const inner = amount * BigInt(10) ** BigInt(RHEA_EXTRA_DECIMALS[token] as number)
  if ((step.body as { max_amount: string }).max_amount !== inner.toString()) {
    refuse('the repayment is not for the amount sent')
  }
}

function assertLendDeposit(transaction: ReadTransaction, account: string): void {
  const { receiverId, calls } = transaction
  const transfer = calls[calls.length - 1] as Call
  if (!hasExactKeys(transfer.args, ['receiver_id', 'amount', 'msg'])) {
    refuse('the deposit has unexpected arguments')
  }
  if (transfer.args['receiver_id'] !== RHEA_LEND) refuse('the deposit does not go to Rhea Lend')
  const amountText = transfer.args['amount']
  if (!isDigits(amountText) || BigInt(amountText) === BigInt(0)) {
    refuse('the deposit has a malformed amount')
  }
  const amount = BigInt(amountText)
  assertWrapPrefix(transaction, account, amount, RHEA_LEND_TOKEN_GAS)
  assertLendMessage(transfer.args['msg'], receiverId, amount)
}

/**
 * Rhea Lend:
 *   supply or repay: [storage_deposit(you) on Rhea Lend]?, then on the token:
 *     [storage_deposit(you)?, near_deposit, ft_transfer_call] for NEAR, or [ft_transfer_call]
 *   withdraw or borrow: [storage_deposit(you) on the token]?, [IncreaseCollateral...]?, the call,
 *     [near_withdraw]? to turn wNEAR back into NEAR
 */
export function assertRheaLendSafe(payload: SigningPayload, account: string): void {
  const transactions = readTransactions(payload, account, 4)
  let money = 0
  let taken: string | undefined

  for (const transaction of transactions) {
    const { receiverId, calls } = transaction
    if (receiverId === RHEA_LEND) {
      if (isRegistration(transaction)) {
        assertOwnStorage(calls[0] as Call, account, RHEA_LEND_STORAGE_YOCTO)
        continue
      }
      const token = assertLendExecute(transaction)
      if (token !== undefined) {
        money += 1
        taken = token
      }
      continue
    }
    if (!LISTED.has(receiverId)) refuse(`${receiverId} is not a listed token`)
    if (isRegistration(transaction)) {
      assertTokenRegistration(transaction, account)
      continue
    }
    if (calls[calls.length - 1]?.method === 'ft_transfer_call') {
      assertLendDeposit(transaction, account)
      money += 1
      continue
    }
    if (calls[0]?.method !== 'near_withdraw') refuse(`${calls[0]?.method} is not allowed`)
    assertUnwrap(transaction)
    if (taken !== WRAP_NEAR) refuse('it unwraps NEAR that this action did not take out')
  }
  if (money > 1) refuse('it moves money more than once')
}
