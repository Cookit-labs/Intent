import { stellarNetwork } from '@intent/config'
import { TransactionBuilder } from '@stellar/stellar-sdk'

import { deliveredFromResultXdr } from './delivered'

/**
 * Submitting a signed swap and finding out whether it worked.
 *
 * Plain REST rather than the SDK's server client: submission is one POST and
 * the failure detail we care about lives in Horizon's `extras.result_codes`,
 * which is easier to read directly than through a wrapped error.
 *
 * The distinction that matters here is between *submitted* and *succeeded*.
 * Horizon returns 200 for a transaction that made it into a ledger; a swap can
 * still fail inside that ledger — `op_under_dest_min` is the important one,
 * meaning the route degraded past the floor and the network correctly refused
 * to fill it. Treating a 200 as success would report a failed swap as done.
 */

export interface SubmitSuccess {
  ok: true
  hash: string
  ledger: number
  /** Explorer link, so a user can verify rather than trust the UI. */
  explorerUrl: string
  /**
   * What the swap actually delivered, in base units, when it can be read.
   *
   * Absent for transactions that delivered nothing, such as placing an offer.
   * A sequence needs this to size its next step against what arrived rather
   * than against what was quoted, and must stop rather than guess when it is
   * missing.
   */
  delivered?: string
}

export interface SubmitFailure {
  ok: false
  reason:
    | 'under_dest_min'
    | 'no_trustline'
    | 'underfunded'
    | 'no_path'
    | 'expired'
    | 'rejected'
    | 'network_error'
    | 'unconfirmed'
    | 'offer_cross_self'
    | 'low_reserve'
    | 'offer_not_found'
  detail?: string
  /** Present when the transaction reached a ledger and failed there. */
  hash?: string
}

export type SubmitResult = SubmitSuccess | SubmitFailure

interface HorizonSubmitResponse {
  hash?: string
  ledger?: number
  successful?: boolean
  /** Base64 transaction result, carrying the amount actually delivered. */
  result_xdr?: string
  extras?: {
    result_codes?: {
      transaction?: string
      operations?: string[]
    }
  }
}

/**
 * Maps Horizon's result codes onto something a user can act on.
 *
 * These strings are the difference between "your swap failed" and "the price
 * moved, try again" — worth translating rather than surfacing raw.
 */
function classify(codes: HorizonSubmitResponse['extras']): SubmitFailure['reason'] {
  const tx = codes?.result_codes?.transaction ?? ''
  const ops = codes?.result_codes?.operations ?? []
  const all = [tx, ...ops].join(' ')

  // Offer-specific codes come first: `low_reserve` also contains no substring
  // the broader checks would catch, but `cross_self` must be distinguished
  // from an ordinary rejection to be explainable.
  if (all.includes('cross_self')) return 'offer_cross_self'
  if (all.includes('low_reserve')) return 'low_reserve'
  if (all.includes('offer_not_found')) return 'offer_not_found'

  if (all.includes('under_dest_min')) return 'under_dest_min'
  if (all.includes('no_trust') || all.includes('no_issuer')) return 'no_trustline'
  if (all.includes('underfunded') || all.includes('insufficient')) return 'underfunded'
  if (all.includes('too_few_offers') || all.includes('no_destination')) return 'no_path'
  if (all.includes('tx_too_late') || all.includes('expired')) return 'expired'
  return 'rejected'
}

export interface SubmitOptions {
  horizonUrl?: string
  fetchImpl?: typeof fetch
  networkPassphrase?: string
  /** How often, and for how long, a timed-out submission is looked up. */
  pollMs?: number
  pollTimeoutMs?: number
}

/** The hash a signed transaction will have on the ledger, read from its bytes. */
export function transactionHashOf(
  signedXdr: string,
  networkPassphrase: string = stellarNetwork.networkPassphrase
): string {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  return Buffer.from(tx.hash()).toString('hex')
}

/**
 * Looks a submission up by hash after Horizon gave no verdict on it.
 *
 * Horizon answers a slow confirmation with a 504 or an empty reply, and the
 * transaction can land moments later. Saying "could not reach the network"
 * then told users a swap had failed while it was settling.
 */
async function lookUpAfterTimeout(
  signedXdr: string,
  why: string,
  options: SubmitOptions
): Promise<SubmitResult> {
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const doFetch = options.fetchImpl ?? fetch
  let hash: string
  try {
    hash = transactionHashOf(signedXdr, options.networkPassphrase)
  } catch {
    console.warn('[submit] no verdict from Horizon and no hash to look up:', why)
    return { ok: false, reason: 'network_error', detail: why }
  }

  const deadline = Date.now() + (options.pollTimeoutMs ?? 25_000)
  const every = options.pollMs ?? 2_000
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(`${horizonUrl}/transactions/${hash}`, { method: 'GET' })
      if (res.ok) {
        const record = (await res.json()) as HorizonSubmitResponse
        if (record.successful === false) {
          return { ok: false, reason: 'rejected', detail: 'failed in the ledger', hash }
        }
        return settled({ ...record, hash })
      }
    } catch {
      // Still unreachable: keep asking until the deadline.
    }
    await new Promise((r) => setTimeout(r, every))
  }

  console.warn('[submit] unconfirmed after a Horizon timeout:', why, hash)
  return { ok: false, reason: 'unconfirmed', detail: why, hash }
}

/** A transaction Horizon reports in a ledger and successful. */
function settled(body: HorizonSubmitResponse & { hash: string }): SubmitSuccess {
  // Read rather than estimated. A caller sequencing a second step against this
  // one needs what arrived, and every alternative source for that figure is a
  // quote taken before the swap ran.
  const delivered =
    body.result_xdr !== undefined ? deliveredFromResultXdr(body.result_xdr) : undefined
  return {
    ok: true,
    hash: body.hash,
    ledger: body.ledger ?? 0,
    explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${body.hash}`,
    ...(delivered !== undefined ? { delivered } : {}),
  }
}

function detailOf(body: HorizonSubmitResponse): string | undefined {
  const ops = body.extras?.result_codes?.operations
  return ops === undefined || ops.length === 0 ? undefined : ops.join(', ')
}

export async function submitSignedSwap(
  signedXdr: string,
  options: SubmitOptions = {}
): Promise<SubmitResult> {
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  let res: Response
  try {
    res = await doFetch(`${horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: signedXdr }).toString(),
    })
  } catch (e) {
    return lookUpAfterTimeout(
      signedXdr,
      e instanceof Error ? e.message : 'the submission did not answer',
      options
    )
  }

  let body: HorizonSubmitResponse
  try {
    body = (await res.json()) as HorizonSubmitResponse
  } catch {
    return lookUpAfterTimeout(signedXdr, `HTTP ${res.status} without a JSON reply`, options)
  }

  // A 5xx is Horizon giving up waiting, not the network refusing: the
  // transaction may still land, so it is looked up rather than classified.
  if (res.status >= 500) {
    return lookUpAfterTimeout(signedXdr, `HTTP ${res.status}`, options)
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: classify(body.extras),
      ...(detailOf(body) !== undefined ? { detail: detailOf(body) as string } : {}),
      ...(body.hash !== undefined ? { hash: body.hash } : {}),
    }
  }

  // A 200 means it reached a ledger, not that the swap filled. `successful`
  // is the field that actually says so.
  if (body.successful === false) {
    return {
      ok: false,
      reason: classify(body.extras),
      ...(detailOf(body) !== undefined ? { detail: detailOf(body) as string } : {}),
      ...(body.hash !== undefined ? { hash: body.hash } : {}),
    }
  }

  if (body.hash === undefined) {
    return lookUpAfterTimeout(signedXdr, 'Horizon returned no hash', options)
  }

  return settled({ ...body, hash: body.hash })
}

/** Human-readable text for each failure, shown directly to the user. */
export const FAILURE_MESSAGES: Record<SubmitFailure['reason'], string> = {
  under_dest_min:
    'The price moved past your slippage tolerance, so the swap was cancelled. Nothing was spent — try again for a fresh quote.',
  no_trustline:
    'Your account cannot hold the destination asset yet. Add a trustline and try again.',
  underfunded: 'Not enough balance, once the network fee and reserve are accounted for.',
  no_path: 'No route could fill this swap at submission time.',
  expired: 'The transaction took too long to submit and expired. Request a fresh quote.',
  rejected: 'The network rejected the transaction.',
  network_error: 'Could not reach the network.',
  unconfirmed:
    'The network did not confirm the transaction in time. It may still go through: check your wallet or the explorer before trying again.',
  offer_cross_self:
    'This order would trade against one of your own resting orders. Cancel the other one first.',
  low_reserve:
    'Not enough XLM to hold another open order. Each one reserves 0.5 XLM until it is cancelled.',
  offer_not_found: 'That order is no longer on the book — it has already filled or been cancelled.',
}

/**
 * What a step's failure says to the user.
 *
 * A submit route answers in one of two shapes: the network's refusal, with a
 * `reason` the table above translates, or the route's own refusal, with an
 * `error` already written for a person — a name that moved between build and
 * submit, say, naming both addresses. Dropping the second showed "That step
 * did not go through" for exactly the refusal the user most needed to read.
 */
export function failureMessage(
  result: { reason?: SubmitFailure['reason']; error?: string },
  fallback = 'That step did not go through.'
): string {
  if (result.reason !== undefined) return FAILURE_MESSAGES[result.reason]
  if (result.error !== undefined && result.error !== '') return result.error
  return fallback
}
