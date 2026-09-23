import { stellarTestnet } from '@intent/config'
import { Keypair } from '@stellar/stellar-sdk'

import { sponsorFee } from './fee-bump'

/**
 * The server-side half of fee sponsorship.
 *
 * A sponsor is a secret key in the environment. When one is set, every
 * signed transaction that reaches a submit route is wrapped in a fee-bump
 * the sponsor pays for; when none is set, nothing changes. The rule for
 * anything in between — a key that will not parse, an account that cannot
 * be funded, a bump that cannot be made — is that the user's transaction
 * still goes out paying its own fee, exactly as before sponsorship existed.
 * Sponsorship removes a cost; it must never add a failure.
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
}

export type SponsoredSubmission =
  | { xdr: string; sponsored: true; feeStroops: string }
  | { xdr: string; sponsored: false; reason?: string }

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

  return { xdr: bumped.xdr, sponsored: true, feeStroops: bumped.feeStroops }
}
