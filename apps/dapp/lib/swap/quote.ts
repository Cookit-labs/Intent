import type { AssetRef, ClassicAsset } from './assets'

/**
 * The seam between "what would this swap cost" and where the answer comes from.
 *
 * Mirrors `ChainAdapter` and `AgentBrain`: one interface, several
 * implementations, compared at the edge. Real aggregation means asking
 * independent sources of liquidity and taking the better answer — Stellar's
 * classic DEX and a Soroban AMM are genuinely different pools, so comparing
 * them is worth doing rather than theatre.
 */

export type QuoteSourceId = 'horizon' | 'soroswap'

/** Fixed input, variable output — an ordinary market swap. */
export interface StrictSendRequest {
  kind: 'strict_send'
  from: ClassicAsset
  to: ClassicAsset
  /** Base units (stroops). A string, never a number. */
  sendAmount: string
}

/** Fixed output, variable input — what a limit-style intent needs. */
export interface StrictReceiveRequest {
  kind: 'strict_receive'
  from: ClassicAsset
  to: ClassicAsset
  /** Base units (stroops). */
  receiveAmount: string
}

export type QuoteRequest = StrictSendRequest | StrictReceiveRequest

/**
 * An executable route.
 *
 * Everything needed to build a transaction, and nothing that needs
 * re-derivation later. Amounts are base-unit strings throughout: a float
 * anywhere in this type is a rounding bug that costs real money.
 */
export interface SwapQuote {
  source: QuoteSourceId
  kind: QuoteRequest['kind']
  from: ClassicAsset
  to: ClassicAsset
  /** What leaves the account, in base units. */
  sendAmount: string
  /** What the quote says arrives, in base units, before slippage tolerance. */
  destAmount: string
  /**
   * Intermediate hops, excluding the endpoints. An empty array is a direct
   * swap; Horizon returns this and it must be replayed exactly, since a
   * different path is a different price.
   */
  path: AssetRef[]
  /** When the quote was taken. Routes go stale; the caller re-quotes before building. */
  quotedAt: string
}

export interface QuoteFailure {
  source: QuoteSourceId
  /** `no_route` is an ordinary outcome for a thin pair, not a fault. */
  reason: 'no_route' | 'unsupported_pair' | 'upstream_error' | 'timeout'
  detail?: string
}

export type QuoteOutcome =
  | { ok: true; quote: SwapQuote }
  | { ok: false; failure: QuoteFailure }

export interface QuoteSource {
  id: QuoteSourceId
  displayName: string
  /** False when the source needs configuration it does not have. */
  isConfigured: () => boolean
  /**
   * Never throws — a source that is down must not take the competition with
   * it. One quoter failing still leaves the other's route usable.
   */
  quote: (req: QuoteRequest, signal?: AbortSignal) => Promise<QuoteOutcome>
}

/**
 * Picks the better of several quotes.
 *
 * Direction matters and is easy to get backwards: on a fixed input the best
 * quote *delivers the most*, while on a fixed output the best quote *spends the
 * least*. Comparison is on BigInt, not Number — these are stroop counts and
 * can exceed what a double represents exactly.
 */
export function bestQuote(quotes: SwapQuote[]): SwapQuote | undefined {
  if (quotes.length === 0) return undefined

  return quotes.reduce((best, candidate) => {
    if (candidate.kind === 'strict_receive') {
      return BigInt(candidate.sendAmount) < BigInt(best.sendAmount) ? candidate : best
    }
    return BigInt(candidate.destAmount) > BigInt(best.destAmount) ? candidate : best
  })
}

/**
 * Collects quotes from every configured source concurrently.
 *
 * `allSettled` semantics by construction: sources return outcomes rather than
 * throwing, so a slow or broken quoter cannot deny the others.
 */
export async function collectQuotes(
  sources: QuoteSource[],
  req: QuoteRequest,
  signal?: AbortSignal
): Promise<{ quotes: SwapQuote[]; failures: QuoteFailure[] }> {
  const outcomes = await Promise.all(
    sources.filter((s) => s.isConfigured()).map((s) => s.quote(req, signal))
  )

  const quotes: SwapQuote[] = []
  const failures: QuoteFailure[] = []
  for (const outcome of outcomes) {
    if (outcome.ok) quotes.push(outcome.quote)
    else failures.push(outcome.failure)
  }
  return { quotes, failures }
}
