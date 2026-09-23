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

/**
 * `soroswap-aggregator` is Soroswap's hosted route-finder, a different
 * product from the `soroswap` AMM: it splits one swap across Soroswap's
 * pools, Aquarius's and the classic book, and several of its answers
 * therefore originate from routers that are already sources of their own.
 * It carries its own id so an agent, and the confirm screen, can tell the
 * two apart — and the direct quoters stay in the line-up beside it rather
 * than being replaced by one vendor's view of them.
 */
export type QuoteSourceId = 'horizon' | 'soroswap' | 'aquarius' | 'soroswap-aggregator'

/** How each source is named where a person reads it. */
const SOURCE_DISPLAY_NAMES: Record<QuoteSourceId, string> = {
  horizon: 'Stellar DEX',
  soroswap: 'Soroswap',
  aquarius: 'Aquarius',
  'soroswap-aggregator': 'Soroswap Aggregator',
}

/** A source's display name, or the raw id for one this build does not know. */
export function sourceDisplayName(id: string): string {
  return (SOURCE_DISPLAY_NAMES as Record<string, string>)[id] ?? id
}

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
  /**
   * What this route actually delivers, when that is not the classic asset named
   * in `to`.
   *
   * A Soroban router settles in a contract token, which is a different asset
   * from the classic issuer of the same code — Soroswap's USDC is not Circle's
   * USDC. Recording it keeps `to` meaningful for display while making the
   * substitution impossible to miss at the point a transaction gets built.
   */
  deliversAsset?: AssetRef
  /**
   * Which pool within the venue, when the venue keeps several for one pair.
   *
   * Aquarius has three XLM/USDC pools with different depth and fees, and a
   * quote from one is not a quote from another — for 20 USDC they answered
   * 32, 42 and 43 XLM. So the pool an agent chose has to travel with the
   * quote to the builder, as a hex-encoded 32-byte index. A builder that
   * re-derived the pool could silently execute a different route than the
   * one that was compared and picked. Absent for venues with one pool per
   * pair, and the Aquarius builder refuses a quote without it.
   */
  poolIndex?: string
  /**
   * How an aggregator splits the fill across venues, when it does.
   *
   * `path` above is empty for such a route — there are no classic hops to
   * replay, the API rebuilds its own plan at signing time — so without this
   * an agent would see "direct" for a swap that went 60% through one AMM and
   * 40% through another by way of a third asset. Present only on aggregator
   * routes; `hops` counts intermediate assets on that leg.
   */
  routePlan?: { protocol: string; percent: string; hops: number }[]
  /**
   * Which shape an aggregator route executes as. The API decides per quote:
   * a split invokes the aggregator contract, a single Soroswap route invokes
   * the router alone, and a classic-book route is a path payment. The
   * builder validates each differently, so the answer travels with the quote.
   */
  platform?: 'aggregator' | 'router' | 'sdex'
  /** When the quote was taken. Routes go stale; the caller re-quotes before building. */
  quotedAt: string
}

export interface QuoteFailure {
  source: QuoteSourceId
  /**
   * `no_route` is an ordinary outcome for a thin pair, not a fault.
   * `unavailable` is the source itself: configured, but unable to learn what
   * it needs before asking — a contract id it could not resolve, an adapter
   * list it could not read, a key the API rejected. Distinct from
   * `upstream_error` because the fix is different: nothing about the market
   * is being reported.
   */
  reason: 'no_route' | 'unsupported_pair' | 'upstream_error' | 'timeout' | 'unavailable'
  detail?: string
}

export type QuoteOutcome = { ok: true; quote: SwapQuote } | { ok: false; failure: QuoteFailure }

/**
 * Every distinct route a source can offer, best first.
 *
 * A venue often has several genuinely different ways to fill the same swap —
 * Stellar will route through an intermediate asset when that beats going
 * direct, and the two can differ by more than a factor of two. Collapsing them
 * to the single best answer is right when one trade is being built, and wrong
 * when four agents are meant to choose between options: a competition over a
 * list of one is a formality.
 */
export type MultiQuoteOutcome =
  | { ok: true; quotes: SwapQuote[] }
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
  /**
   * Every route this source can offer, rather than only its best.
   *
   * Optional because not every venue has more than one answer to give: a
   * single-pool AMM quotes one price and that is the whole truth. Sources that
   * omit it are simply treated as offering the one quote they return.
   */
  quoteAll?: (req: QuoteRequest, signal?: AbortSignal) => Promise<MultiQuoteOutcome>
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
