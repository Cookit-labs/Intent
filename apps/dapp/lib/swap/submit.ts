import { stellarTestnet } from '@intent/config'

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
  detail?: string
  /** Present when the transaction reached a ledger and failed there. */
  hash?: string
}

export type SubmitResult = SubmitSuccess | SubmitFailure

interface HorizonSubmitResponse {
  hash?: string
  ledger?: number
  successful?: boolean
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
}

function detailOf(body: HorizonSubmitResponse): string | undefined {
  const ops = body.extras?.result_codes?.operations
  return ops === undefined || ops.length === 0 ? undefined : ops.join(', ')
}

export async function submitSignedSwap(
  signedXdr: string,
  options: SubmitOptions = {}
): Promise<SubmitResult> {
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const doFetch = options.fetchImpl ?? fetch

  let res: Response
  try {
    res = await doFetch(`${horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: signedXdr }).toString(),
    })
  } catch (e) {
    return {
      ok: false,
      reason: 'network_error',
      ...(e instanceof Error ? { detail: e.message } : {}),
    }
  }

  let body: HorizonSubmitResponse
  try {
    body = (await res.json()) as HorizonSubmitResponse
  } catch {
    return { ok: false, reason: 'network_error', detail: `HTTP ${res.status}` }
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
    return { ok: false, reason: 'network_error', detail: 'Horizon returned no hash' }
  }

  return {
    ok: true,
    hash: body.hash,
    ledger: body.ledger ?? 0,
    explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${body.hash}`,
  }
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
}
