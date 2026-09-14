import { toBaseUnits } from './assets'
import { fetchStellarBalances } from '../stellar-account'

/**
 * How much of an asset actually arrived, measured from the account.
 *
 * The venue-independent way to answer the question a sequence has to answer
 * before its second step: how much is there to supply?
 *
 * Reading it from the transaction result works only for classic path payments.
 * A Soroban router reports its output as a contract return value, which lives
 * in `result_meta_xdr`, and Horizon's transaction endpoint does not return that
 * field — so an agent that picked Soroswap left the sequence unable to size
 * what followed. Measuring the balance sidesteps the question of which venue
 * executed, because the account is the same either way.
 *
 * **Fees are the reason this is not simply "the new balance".** On XLM the
 * network charges from the same balance the swap credits, so the delta is what
 * arrived minus what the fee took. That is the correct figure to supply anyway:
 * it is what the account actually holds.
 */

/** Long enough for a settled ledger to be reflected, short enough not to stall. */
const SETTLE_GRACE_MS = 1_500

export interface BalanceDeltaOptions {
  /** Injected in tests. */
  fetchBalances?: typeof fetchStellarBalances
  /** Injected in tests, so the wait is not real. */
  waitMs?: number
}

/** The balance of one asset, in base units, or undefined when not held. */
export async function balanceOf(
  account: string,
  symbol: string,
  options: BalanceDeltaOptions = {}
): Promise<bigint | undefined> {
  const fetchImpl = options.fetchBalances ?? fetchStellarBalances
  const balances = await fetchImpl(account)
  if (!balances.exists) return undefined

  const display = symbol === 'XLM' ? balances.xlm : balances.trustlines[symbol]?.balance
  if (display === undefined) return undefined

  try {
    return BigInt(toBaseUnits(display))
  } catch {
    return undefined
  }
}

/**
 * What a settled transaction added to the account, in base units.
 *
 * Takes the balance from *before* the transaction, so the caller must capture
 * it first. Returns nothing when the balance did not grow — which is the honest
 * answer, and the caller must stop rather than supply a guessed amount.
 */
export async function deliveredByBalanceChange(
  account: string,
  symbol: string,
  balanceBefore: bigint,
  options: BalanceDeltaOptions = {}
): Promise<string | undefined> {
  // Horizon reflects a settled ledger a moment after submission returns, so a
  // read taken immediately can still show the old balance and report that
  // nothing arrived.
  const wait = options.waitMs ?? SETTLE_GRACE_MS
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))

  const after = await balanceOf(account, symbol, options)
  if (after === undefined) return undefined

  const delta = after - balanceBefore
  // Zero or negative means nothing arrived that this can attribute to the
  // swap. Reporting a figure anyway would be inventing one.
  if (delta <= BigInt(0)) return undefined

  return delta.toString()
}
