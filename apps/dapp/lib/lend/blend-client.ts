import { stellarTestnet } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'

/**
 * Supplying to Blend.
 *
 * A fourth builder, separate for the same reason the Soroswap one is: each
 * asserts the shape it produces, and widening an assertion to admit another
 * shape weakens the guarantee it exists to make.
 *
 * **The recipient is the risk here, as it is with the router.** Blend's
 * `submit` takes three addresses, and the pool credits the position to whatever
 * `to` names. A supply that credits somebody else is a gift wearing a deposit's
 * clothes, so all three are pinned to the signer and read back out of the
 * encoded bytes rather than trusted from the arguments.
 *
 * Borrowing is deliberately absent. A supply-only position cannot be
 * liquidated — the pool never checks health on a supply, and it panics outright
 * when asked to open a liquidation auction against an account with no
 * liabilities. That guarantee holds only while nothing here can open one.
 */

/**
 * Supply, in Blend's request enum.
 *
 * Type 2 is `SupplyCollateral`, which also earns yield but backs borrowing.
 * For a yield-only feature 0 is both correct and the safer default: it cannot
 * become collateral for a liability the user did not ask for.
 */
const REQUEST_TYPE_SUPPLY = 0

/**
 * Withdraw, in Blend's request enum.
 *
 * The counterpart to Supply and the exact inverse: type 1 takes back what type
 * 0 put in. Type 3 is `WithdrawCollateral`, which this app never needs because
 * it never supplies as collateral — a position opened here is always type 0, so
 * it always comes out as type 1.
 *
 * Verified against the live pool before being written: simulating a type-1
 * submit for 1 XLM, for 500 XLM, and for the whole position all succeeded, the
 * last leaving `supply: {}` behind.
 */
const REQUEST_TYPE_WITHDRAW = 1

/**
 * Asking for more than the position holds withdraws all of it.
 *
 * The pool clamps a withdrawal to the balance rather than reverting, which is
 * the only way to empty a position exactly. Interest accrues every ledger, so a
 * figure read a moment ago is already short by the time it is signed — asking
 * for an exact "everything" would reliably leave dust behind. `i128::MAX` is
 * how Blend's own interface expresses this.
 */
const WITHDRAW_EVERYTHING = '170141183460469231731687303715884105727'

const TIMEOUT_SECONDS = 180

export interface BuildSupplyOptions {
  /** The account supplying, and the only account that may be credited. */
  account: string
  /** The reserve's asset, as a contract id. Read from the pool, never derived. */
  asset: string
  /** Base units. A string, never a number. */
  amount: string
  poolId?: string
  horizonUrl?: string
  rpcUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltSupply {
  xdr: string
  /** Echoed back and asserted: the account credited with the position. */
  recipient: string
  asset: string
  amount: string
  networkPassphrase: string
}

/**
 * One entry in Blend's `requests` vector.
 *
 * **Soroban serialises struct fields alphabetically**, so the wire order is
 * `address, amount, request_type` even though the Rust source declares
 * `request_type` first. `nativeToScVal` with a type map handles that; a
 * hand-rolled `scvMap` written in source order would encode a struct the pool
 * cannot read, and the failure would surface as an opaque simulation error
 * rather than anything naming field order.
 */
function poolRequest(asset: string, amount: string, requestType: number): xdr.ScVal {
  return nativeToScVal(
    {
      address: new Address(asset),
      amount: BigInt(amount),
      request_type: requestType,
    },
    {
      type: {
        address: ['symbol', 'address'],
        amount: ['symbol', 'i128'],
        request_type: ['symbol', 'u32'],
      },
    }
  )
}

function supplyRequest(asset: string, amount: string): xdr.ScVal {
  return poolRequest(asset, amount, REQUEST_TYPE_SUPPLY)
}

async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error('This account is not funded yet, so it cannot supply.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

/**
 * Builds an unsigned supply.
 *
 * Its own transaction rather than a step inside a shared envelope, because
 * **Soroban permits exactly one operation per transaction**. Verified on
 * testnet twice: a path payment beside a contract call is refused, and so are
 * two contract calls. A swap and a supply therefore cannot share a signature,
 * which is a protocol fact rather than a limitation of this code.
 */
export async function buildBlendSupply(options: BuildSupplyOptions): Promise<BuiltSupply> {
  const { account, asset, amount } = options
  const poolId = options.poolId ?? BLEND_POOL
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (BigInt(amount) <= BigInt(0)) {
    throw new Error('a supply needs a positive amount')
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // Stated once, here, and asserted below. `from` spends, `spender` authorises,
  // `to` is credited — and the pool will happily credit a third party, which is
  // exactly why this is not a parameter.
  const recipient = account

  const operation = new Contract(poolId).call(
    'submit',
    new Address(account).toScVal(),
    new Address(account).toScVal(),
    new Address(recipient).toScVal(),
    xdr.ScVal.scvVec([supplyRequest(asset, amount)])
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const built = tx.toXDR()
  assertSelfSupply(built, account)

  return {
    xdr: built,
    recipient,
    asset,
    amount,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone supply
 * crediting this account.
 *
 * The three addresses are checked individually. Two of three being the signer
 * is not close enough: `to` alone decides who ends up holding the position, so
 * a transaction correct in every other respect can still hand the deposit away.
 */
export function assertSelfSupply(built: string, account: string): void {
  assertSelfPoolCall(built, account, 'supply')
}

/**
 * The same check for a withdrawal.
 *
 * Every rule that makes a supply safe applies unchanged here, because it is the
 * same `submit` call with the same three addresses — and `to` still decides who
 * receives the money. A withdrawal naming somebody else as `to` would take the
 * user's position and pay it to a stranger, which is the recipient-substitution
 * risk in its most direct form: on the way *out* the funds leave the pool
 * entirely rather than merely landing in the wrong position.
 */
export function assertSelfWithdraw(built: string, account: string): void {
  assertSelfPoolCall(built, account, 'withdrawal')
}

/**
 * Re-reads a built pool call and refuses anything that is not a lone `submit`
 * acting entirely on behalf of this account.
 *
 * `noun` only shapes the wording. The checks are identical for a supply and a
 * withdrawal by design: they are the same contract function with the same
 * argument shape, so a second implementation could only drift away from this
 * one.
 */
function assertSelfPoolCall(built: string, account: string, noun: 'supply' | 'withdrawal'): void {
  const decoded = TransactionBuilder.fromXDR(built, stellarTestnet.networkPassphrase)

  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }

  if (tx.operations.length !== 1) {
    throw new Error(`expected exactly one operation, found ${tx.operations.length}`)
  }

  const op = tx.operations[0]
  if (op === undefined) throw new Error('transaction has no operation')
  if (op.type !== 'invokeHostFunction') {
    throw new Error(`operation ${op.type} is not a contract invocation`)
  }

  const hostFunction = (op as unknown as { func?: { type?: string; invokeContract?: unknown } })
    .func
  if (hostFunction?.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error('refusing to sign: this is not a contract invocation')
  }

  const invocation = hostFunction.invokeContract as
    | { functionName?: unknown; args?: xdr.ScVal[] }
    | undefined
  if (invocation === undefined) throw new Error('refusing to sign: the call could not be read')

  // `functionName` decodes to an `XdrString`, not a plain string and not a byte
  // array. `Buffer.from()` on it silently yields zero bytes.
  if (String(invocation.functionName) !== 'submit') {
    throw new Error(
      `refusing to sign: ${String(invocation.functionName)} is not a ${noun}. ` +
        'Only submit may be built here.'
    )
  }

  const args = invocation.args ?? []
  if (args.length !== 4) {
    throw new Error(`refusing to sign: a ${noun} takes four arguments, found ${args.length}`)
  }

  const NAMES = ['from', 'spender', 'to']
  NAMES.forEach((name, index) => {
    const arg = args[index]
    if (arg === undefined) {
      throw new Error(`refusing to sign: the ${noun} has no ${name} address`)
    }
    const address = Address.fromScVal(arg).toString()
    if (address !== account) {
      throw new Error(
        `refusing to sign: the ${noun} names ${address} as ${name}, not the signing account. ` +
          `A ${noun} must credit the account that funds it.`
      )
    }
  })
}

export interface BuildWithdrawOptions {
  /** The account withdrawing, and the only account that may be paid. */
  account: string
  /** The reserve's asset, as a contract id. Read from the pool, never derived. */
  asset: string
  /**
   * Base units to withdraw, or omitted to take the whole position.
   *
   * Omitting it is not the same as passing the balance read a moment ago:
   * interest accrues every ledger, so an exact figure is stale by the time it
   * is signed and would leave dust behind. See `WITHDRAW_EVERYTHING`.
   */
  amount?: string
  poolId?: string
  horizonUrl?: string
  rpcUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltWithdraw {
  xdr: string
  /** Echoed back and asserted: the account the funds are paid to. */
  recipient: string
  asset: string
  /** What was asked for, including the sentinel when taking everything. */
  amount: string
  /** True when this empties the position rather than taking a named amount. */
  everything: boolean
  networkPassphrase: string
}

/**
 * Builds an unsigned withdrawal.
 *
 * The exact inverse of `buildBlendSupply` and deliberately built the same way,
 * down to the one-operation envelope: Soroban permits exactly one operation per
 * transaction, so this cannot be bundled with anything either.
 *
 * Unlike a supply there is no cap or trustline to trip over on the way out, but
 * there is a liquidity constraint the pool enforces: a withdrawal fails if it
 * would push utilisation past `max_util` (95% here). The simulation catches
 * that before the user is asked to sign.
 */
export async function buildBlendWithdraw(options: BuildWithdrawOptions): Promise<BuiltWithdraw> {
  const { account, asset } = options
  const poolId = options.poolId ?? BLEND_POOL
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  const everything = options.amount === undefined
  const amount = everything ? WITHDRAW_EVERYTHING : (options.amount as string)

  if (!everything && BigInt(amount) <= BigInt(0)) {
    throw new Error('a withdrawal needs a positive amount')
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // The same three addresses as a supply, and the same reason they are not
  // parameters: `to` decides who is paid, and the pool will pay anyone.
  const recipient = account

  const operation = new Contract(poolId).call(
    'submit',
    new Address(account).toScVal(),
    new Address(account).toScVal(),
    new Address(recipient).toScVal(),
    xdr.ScVal.scvVec([poolRequest(asset, amount, REQUEST_TYPE_WITHDRAW)])
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const built = tx.toXDR()
  assertSelfWithdraw(built, account)

  return {
    xdr: built,
    recipient,
    asset,
    amount,
    everything,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/**
 * What the position still holds after the withdrawal, from the simulation.
 *
 * **Not the amount withdrawn**, which is the trap this function exists to avoid
 * falling into. `submit` returns the account's positions *after* the call, so
 * reading `supply` here gives the remainder — reporting it as the sum taken out
 * would be exactly wrong, and most wrong on a full withdrawal, where the
 * remainder is zero and the amount taken is everything.
 */
function readRemainingTokens(sim: rpc.Api.SimulateTransactionSuccessResponse): string | undefined {
  try {
    const positions = scValToNative(sim.result?.retval as xdr.ScVal) as
      | { supply?: Record<string, unknown> }
      | undefined

    const supply = positions?.supply
    if (supply === undefined) return undefined

    // An emptied position returns no supply entry at all rather than a zero,
    // so an absent reserve here means nothing left.
    const first = Object.values(supply)[0]
    return first === undefined ? '0' : String(first)
  } catch {
    return undefined
  }
}

/**
 * Simulates the withdrawal, which Soroban requires before submission.
 *
 * The feasibility check matters as much here as for a supply, for a different
 * reason: withdrawals revert once they would push the reserve past `max_util`.
 * That is live rather than theoretical — this pool sits around 90% against a
 * 95% ceiling — so a large withdrawal can genuinely be refused by the pool
 * while the position is perfectly real.
 */
export async function prepareBlendWithdraw(
  built: string,
  rpcUrl: string = stellarTestnet.sorobanRpcUrl
): Promise<{ ok: true; xdr: string; remaining?: string } | { ok: false; reason: string }> {
  const server = new rpc.Server(rpcUrl)

  let tx
  try {
    tx = TransactionBuilder.fromXDR(built, stellarTestnet.networkPassphrase)
  } catch {
    return { ok: false, reason: 'The transaction could not be read.' }
  }
  if (tx instanceof FeeBumpTransaction) {
    return { ok: false, reason: 'Fee-bump transactions are not supported.' }
  }

  try {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // The pool's own revert reason. It distinguishes "not enough liquidity"
      // from "nothing to withdraw", which a generic failure would not.
      return { ok: false, reason: sim.error }
    }

    const prepared = rpc.assembleTransaction(tx, sim).build()
    const result: { ok: true; xdr: string; remaining?: string } = {
      ok: true,
      xdr: prepared.toXDR(),
    }

    const remaining = readRemainingTokens(sim)
    if (remaining !== undefined) result.remaining = remaining

    return result
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Simulation failed.' }
  }
}

/**
 * Simulates the supply, which Soroban requires before submission.
 *
 * More than an estimate, and worth doing for the second reason alone: it
 * surfaces an exceeded supply cap, a disabled reserve, or an insufficient
 * balance *before* the user is asked to sign, rather than as an on-chain
 * failure they have already paid a fee for.
 */
export async function prepareBlendSupply(
  built: string,
  rpcUrl: string = stellarTestnet.sorobanRpcUrl
): Promise<{ ok: true; xdr: string; bTokens?: string } | { ok: false; reason: string }> {
  const server = new rpc.Server(rpcUrl)

  let tx
  try {
    tx = TransactionBuilder.fromXDR(built, stellarTestnet.networkPassphrase)
  } catch {
    return { ok: false, reason: 'The transaction could not be read.' }
  }
  if (tx instanceof FeeBumpTransaction) {
    return { ok: false, reason: 'Fee-bump transactions are not supported.' }
  }

  try {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // The pool's own revert reason, which distinguishes "cap reached" from
      // "not enough balance" far better than a generic failure would.
      return { ok: false, reason: sim.error }
    }

    const prepared = rpc.assembleTransaction(tx, sim).build()
    const result: { ok: true; xdr: string; bTokens?: string } = {
      ok: true,
      xdr: prepared.toXDR(),
    }

    const bTokens = readSuppliedTokens(sim)
    if (bTokens !== undefined) result.bTokens = bTokens

    return result
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Simulation failed.' }
  }
}

/**
 * How many bTokens the supply would mint, from the simulated result.
 *
 * **Approximate, and it cannot be made exact.** Interest accrues every ledger,
 * so three identical simulations of the same 10 XLM returned three different
 * figures. Blend's `submit` takes no minimum-out, so unlike a swap there is no
 * floor to set — which is why anything built on this must say "about".
 */
function readSuppliedTokens(sim: rpc.Api.SimulateTransactionSuccessResponse): string | undefined {
  try {
    const positions = scValToNative(sim.result?.retval as xdr.ScVal) as
      | { supply?: Record<string, unknown> }
      | undefined

    const supply = positions?.supply
    if (supply === undefined) return undefined

    const first = Object.values(supply)[0]
    return first === undefined ? undefined : String(first)
  } catch {
    return undefined
  }
}
