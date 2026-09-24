import { stellarTestnet } from '@intent/config'
import { Keypair } from '@stellar/stellar-sdk'

import { getSponsorLedger, type SponsorLedger } from '../server/sponsor-ledger'
import { budgetLimits, dayOf, describeBudget, withinBudget, type BudgetReport } from './budget'
import { sponsorFee } from './fee-bump'

/**
 * The server-side half of fee sponsorship.
 *
 * A sponsor is a secret key in the environment. When one is set, every
 * signed transaction that reaches a submit route is wrapped in a fee-bump
 * the sponsor pays for; when none is set, nothing changes. The rule for
 * anything in between — a key that will not parse, an account that cannot
 * be funded, a bump that cannot be made, a day's budget already spent — is
 * that the user's transaction still goes out paying its own fee, exactly as
 * before sponsorship existed. Sponsorship removes a cost; it must never add
 * a failure.
 *
 * The budget is what bounds the key. Each fee is capped in `fee-bump.ts`,
 * but a thousand small fees drain an account as surely as one large one, so
 * a day's total and any one account's count are capped too, in a ledger
 * the submit routes share through Postgres.
 *
 * Testnet only in one respect: an unfunded sponsor account is created
 * through friendbot on first use, so a fresh deployment does not need a
 * hand-funded key before it can pay. Nothing here would fund anything on
 * mainnet, and the app executes only on testnet today.
 */

const ENV_KEY = 'SPONSOR_SECRET_KEY'

type Env = Record<string, string | undefined>

export function sponsorConfigured(env: Env = process.env): boolean {
  const key = env[ENV_KEY]
  return key !== undefined && key.trim() !== ''
}

/** Which account will pay the fee of a transaction submitted through the app. */
export function feePaidBy(env: Env = process.env): 'sponsor' | 'account' {
  return sponsorConfigured(env) ? 'sponsor' : 'account'
}

/** The sponsor's public key, when one is configured and parses. */
export function sponsorAccount(env: Env = process.env): string | undefined {
  const key = env[ENV_KEY]
  if (key === undefined || key.trim() === '') return undefined
  try {
    return Keypair.fromSecret(key.trim()).publicKey()
  } catch {
    return undefined
  }
}

export interface SponsorForSubmissionOptions {
  env?: Env
  fetchImpl?: typeof fetch
  horizonUrl?: string
  friendbotUrl?: string
  maxFeeStroops?: bigint
  /** The day's ledger; the Postgres one when absent. */
  ledger?: SponsorLedger
  now?: Date
}

export type SponsoredSubmission =
  | { xdr: string; sponsored: true; feeStroops: string }
  | { xdr: string; sponsored: false; reason?: string }

let warnedLedgerUnreachable = false

/**
 * Whether today has room for this fee, recording it when it does.
 *
 * A ledger that cannot be reached is an allow. Sponsorship must never add a
 * failure, and that includes its own bookkeeping failing; a database blip
 * should cost the budget its accuracy for a moment, not cost users their
 * fees. Said once in the log, then quiet until the process restarts.
 */
async function commitToBudget(
  account: string,
  feeStroops: bigint,
  env: Env,
  now: Date,
  ledger: SponsorLedger | undefined
): Promise<boolean> {
  try {
    const book = ledger ?? (await getSponsorLedger())
    const day = dayOf(now)
    if (!withinBudget(await book.usage(day, account), feeStroops, budgetLimits(env))) return false
    await book.record(day, account, feeStroops)
    return true
  } catch (e) {
    if (!warnedLedgerUnreachable) {
      warnedLedgerUnreachable = true
      console.warn(
        `[sponsor-ledger] database unreachable, sponsoring without a budget: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    return true
  }
}

/**
 * Makes sure the sponsor account exists on the ledger, funding it from
 * friendbot if it does not. Throws when the account can neither be found
 * nor funded; the caller then submits unsponsored.
 */
async function ensureFunded(
  account: string,
  doFetch: typeof fetch,
  horizonUrl: string,
  friendbotUrl: string
): Promise<void> {
  const res = await doFetch(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.ok) return
  if (res.status !== 404) throw new Error(`Horizon ${res.status}`)
  const funded = await doFetch(`${friendbotUrl}/?addr=${encodeURIComponent(account)}`)
  if (!funded.ok) throw new Error(`Friendbot ${funded.status}`)
}

export async function sponsorForSubmission(
  signedXdr: string,
  account: string,
  options: SponsorForSubmissionOptions = {}
): Promise<SponsoredSubmission> {
  const env = options.env ?? process.env
  if (!sponsorConfigured(env)) return { xdr: signedXdr, sponsored: false }

  let sponsor: Keypair
  try {
    sponsor = Keypair.fromSecret((env[ENV_KEY] as string).trim())
  } catch {
    return { xdr: signedXdr, sponsored: false, reason: 'invalid_sponsor_key' }
  }

  try {
    await ensureFunded(
      sponsor.publicKey(),
      options.fetchImpl ?? fetch,
      options.horizonUrl ?? stellarTestnet.horizonUrl,
      options.friendbotUrl ?? stellarTestnet.friendbotUrl
    )
  } catch {
    return { xdr: signedXdr, sponsored: false, reason: 'sponsor_unfunded' }
  }

  const bumped = sponsorFee(signedXdr, account, {
    sponsor,
    passphrase: stellarTestnet.networkPassphrase,
    ...(options.maxFeeStroops !== undefined ? { maxFeeStroops: options.maxFeeStroops } : {}),
  })
  if (!bumped.ok) return { xdr: signedXdr, sponsored: false, reason: bumped.reason }

  // Checked after the bump is built rather than before, because the fee the
  // budget has to hold is the one the bump names, and the bump is the only
  // place it is computed. Building one is local and costs nothing.
  const room = await commitToBudget(
    account,
    BigInt(bumped.feeStroops),
    env,
    options.now ?? new Date(),
    options.ledger
  )
  if (!room) return { xdr: signedXdr, sponsored: false, reason: 'budget' }

  return { xdr: bumped.xdr, sponsored: true, feeStroops: bumped.feeStroops }
}

/**
 * Today's budget and how much of it is spent, for `GET /api/sponsor`.
 * Undefined when the ledger cannot be reached: the route answers what it
 * can rather than failing over a number that is only informational.
 */
export async function sponsorBudgetToday(
  options: { env?: Env; ledger?: SponsorLedger; now?: Date } = {}
): Promise<BudgetReport | undefined> {
  const day = dayOf(options.now ?? new Date())
  try {
    const book = options.ledger ?? (await getSponsorLedger())
    return describeBudget(day, await book.usage(day), budgetLimits(options.env ?? process.env))
  } catch {
    return undefined
  }
}
