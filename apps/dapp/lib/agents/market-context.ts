import {
  CHAIN_DESCRIPTORS,
  activeNetwork,
  isChainSlug,
  type StellarNetworkName,
} from '@intent/config'

import type { MarketContext, QuotedRoute } from './brain'
import type { MarketPrice } from '../swap/price-types'
import { fromBaseUnits, resolveAsset } from '../swap/assets'
import { activeSources, type QuoteSource, type SwapQuote } from '../swap/quote'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'
import { createAquariusQuoter } from '../swap/sources/aquarius-quoter'
import { createSoroswapQuoter } from '../swap/sources/soroswap-quoter'
import { fetchFxPrices } from '../prices/reflector'
import { createSoroswapAggregatorQuoter } from '../swap/sources/soroswap-aggregator-quoter'
import { fetchMarketPrices, toPriceTable } from '../swap/prices'
import { REFERENCE_PRICES_USD } from '../parse-intent'
import { tradeableSymbols, trustSummary, verificationOf } from '../swap/asset-registry'
import { isVenueOn, venues } from '../venues'
import type { Env } from '../lend/defindex/config'
import { VAULT_KEYS } from '../lend/defindex/contracts'
import { readDefindexRate, type DefindexRate } from '../lend/defindex/rate'
import { BLEND_XLM, readReserve, type Reserve } from '../lend/reserves'
import { configuredLendingVenues } from '../lend/venues'
import { anchorOn, anchorsOn, type AnchorEntry } from '../offramp/anchors'
import { readWithdrawInfo } from '../offramp/sep24'
import { readAnchorToml } from '../offramp/toml'
import { readPerpFacts } from '../perps/market-facts'
import { createNoetherClient } from '../perps/noether-client'

/**
 * Assembles the facts an agent is allowed to reason from.
 *
 * Everything here is passed into the prompt rather than left to the model's
 * memory. That is the direct mitigation for the weakest part of a cheap model's
 * output: it will happily state a confident, wrong spot price, and that number
 * would flow straight into a projected fill the user sees.
 *
 * When a real price feed exists, only this file changes.
 */
/**
 * Prices the intent against live liquidity, so agents choose between real
 * routes instead of describing hypothetical ones.
 *
 * Returns an empty list rather than throwing when the pair is unswappable or
 * the chain cannot execute. A competition with no routes is still a
 * competition — the agents reason about the intent and simply cannot offer
 * execution, which is honest rather than broken.
 */
export interface QuoteRoutesOptions {
  /**
   * Minimum acceptable output, in base units.
   *
   * A limit order only makes sense if it can decline. Without this a "sell 100
   * XLM at $0.25" quote is indistinguishable from a market order and fills at
   * whatever the book offers, which is the opposite of what was asked.
   */
  minReceive?: string
  /** Injected in tests. Every venue otherwise; see `defaultQuoteSources`. */
  sources?: QuoteSource[]
}

/**
 * Every venue the agents may be offered a route from.
 *
 * Four independent pools, and one that is not independent of two of them:
 * Horizon covers the classic DEX and its AMMs, Soroswap and Aquarius are
 * Soroban contracts with their own depth, and the Soroswap *aggregator* is a
 * hosted route-finder that splits a swap across those same venues. It stays
 * a fifth source under its own id rather than replacing the direct quoters,
 * because several of its answers are one vendor's view of routers the app
 * can already ask itself — and a comparison needs the independent answers
 * to compare against. Absent without `SOROSWAP_API_KEY`: `isConfigured`
 * is false, and an unconfigured source is skipped rather than asked.
 */
export function defaultQuoteSources(): QuoteSource[] {
  return [
    createHorizonQuoter(),
    createAquariusQuoter(),
    createSoroswapQuoter(),
    createSoroswapAggregatorQuoter(),
  ]
}

/**
 * Every route a source can offer, or its one route when it offers no list.
 *
 * Horizon returns every path and Aquarius every pool, and both are worth
 * choosing between: collapsing them handed four agents a list of one, which
 * is why they kept reaching the same answer. A source without `quoteAll`
 * simply has the one price to give.
 */
async function everyRoute(
  source: QuoteSource,
  req: Parameters<QuoteSource['quote']>[0],
  signal?: AbortSignal
): Promise<SwapQuote[]> {
  if (source.quoteAll !== undefined) {
    const all = await source.quoteAll(req, signal)
    return all.ok ? all.quotes : []
  }
  const one = await source.quote(req, signal)
  return one.ok ? [one.quote] : []
}

/**
 * Where a route goes, in words an agent can choose on.
 *
 * "2 hops" twice says nothing; "via EURC" against "direct" is a real
 * difference. An aggregator route has no classic hops to name — `path` is
 * empty because the API replays its own plan — so its `routePlan` is
 * described instead: a swap split 60/40 across two AMMs must not read
 * "direct" beside a direct quote from either one.
 */
function describeVia(quote: SwapQuote): string {
  if (quote.routePlan !== undefined && quote.routePlan.length > 0) {
    const legs = quote.routePlan.map(
      (leg) =>
        `${leg.percent}% ${leg.protocol} ${leg.hops === 0 ? 'direct' : `via ${leg.hops} hop${leg.hops === 1 ? '' : 's'}`}`
    )
    return legs.length === 1 ? (legs[0] as string) : `split ${legs.join(' + ')}`
  }
  return quote.path.length === 0 ? 'direct' : quote.path.map((h) => h.code).join(' → ')
}

/** How many intermediate assets a route touches — the longest leg, for a split. */
function hopsOf(quote: SwapQuote): number {
  if (quote.routePlan !== undefined && quote.routePlan.length > 0) {
    return Math.max(...quote.routePlan.map((leg) => leg.hops))
  }
  return quote.path.length
}

export async function quoteRoutes(
  chain: string,
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  signal?: AbortSignal,
  options: QuoteRoutesOptions = {}
): Promise<QuotedRoute[]> {
  if (chain !== 'stellar') return []

  const from = resolveAsset(fromSymbol)
  const to = resolveAsset(toSymbol)
  if (from === undefined || to === undefined) return []
  if (from.code === to.code && from.issuer === to.issuer) return []

  // Every venue asked at once, and every route each can offer. Sources
  // return outcomes rather than throwing, so one being down cannot take the
  // others with it; an unconfigured one is skipped rather than asked.
  const req = { kind: 'strict_send' as const, from, to, sendAmount: amount }
  const sources = activeSources(options.sources ?? defaultQuoteSources())
  const perSource = await Promise.all(sources.map((s) => everyRoute(s, req, signal)))
  const quotes = perSource.flat()

  // A limit that the market cannot meet returns nothing, so the competition
  // reports "no route" rather than offering a fill the user did not ask for.
  const acceptable =
    options.minReceive === undefined
      ? quotes
      : quotes.filter((q) => BigInt(q.destAmount) >= BigInt(options.minReceive as string))

  return acceptable.map((quote, index) => ({
    // Indexed by source so an agent naming a route cannot accidentally match
    // one from a different competition.
    id: `${quote.source}-${index + 1}`,
    source: quote.source,
    // Human-scale, because asking a model to divide by 10^7 invites arithmetic
    // errors in exactly the number the user reads.
    sendAmount: `${fromBaseUnits(quote.sendAmount)} ${quote.from.code}`,
    receiveAmount: `${fromBaseUnits(quote.destAmount)} ${quote.to.code}`,
    hops: hopsOf(quote),
    via: describeVia(quote),
    // Soroban tokens are separate contracts from classic issuers, so the USDC
    // Soroswap delivers is not the USDC Horizon delivers. Surfacing that keeps
    // an agent from reading two quotes as interchangeable and picking purely
    // on the larger number.
    // Only routes this app can actually build are offerable. The rest are
    // shown for comparison, which is the point of quoting two venues.
    // Executable when the route delivers the asset it names. The venue no
    // longer decides: a Soroswap route through canonical Stellar Asset
    // Contracts settles in the same XLM a path payment would, and refusing it
    // meant the agents could see a 3.7x better price and never take it.
    //
    // `deliversAsset` remains the guard, and it is the right one — it is set
    // precisely when a route would hand over a token that merely shares a
    // ticker with what the user asked for.
    executable: quote.deliversAsset === undefined,
    ...(quote.deliversAsset !== undefined
      ? { note: `settles in Soroban ${quote.to.code}, a different asset — not executable yet` }
      : {}),
    quote,
  }))
}

/**
 * Market context with live prices where they are available.
 *
 * Async because the price lookup is a network call. The synchronous version is
 * kept for callers that cannot await, and for chains with no price source.
 */
export async function buildMarketContextAsync(chain: string): Promise<MarketContext> {
  const base = buildMarketContext(chain)
  if (chain !== 'stellar') return base

  const [prices, fx, lending, offramps, perps] = await Promise.all([
    fetchMarketPrices(),
    fetchFxRates(),
    fetchLendingRates(),
    fetchOfframpLimits(),
    fetchPerpFacts(),
  ])

  return {
    ...base,
    // Real mainnet prices replace the indicative table. Testnet execution
    // still quotes its own synthetic rate; agents are told which is which.
    // FX and gold sit in the same table: CETES is priced in pesos and a
    // Brazilian bond in reais, and an agent without those rates can only
    // compare them to the dollar by guessing.
    prices: { ...base.prices, ...toPriceTable(prices), ...toPriceTable(fx) },
    // Omitted rather than empty when the read fails, so an agent sees "no
    // lending data" instead of "lending pays nothing".
    ...(lending.length > 0 ? { lending } : {}),
    // Same omission discipline: absent means "could not be read", not "no
    // limits apply".
    ...(offramps.length > 0 ? { offramps } : {}),
    // And again: absent means the perps venue could not be read or is paused.
    ...(perps !== undefined ? { perps } : {}),
  }
}

/**
 * Live perp figures from Noether. Silent on failure like the two above; the
 * gateway is a dev-tagged container app and a competition must not wait on
 * it or fail with it.
 */
async function fetchPerpFacts(): Promise<MarketContext['perps']> {
  // Testnet-only venue: anywhere else its figures are not facts about this
  // market, and they are left out exactly as when the gateway cannot be read.
  const noether = venues.find((v) => v.id === 'noether')
  if (noether === undefined || !isVenueOn(noether)) return undefined
  try {
    return await readPerpFacts(createNoetherClient())
  } catch {
    return undefined
  }
}

export type LendingRate = NonNullable<MarketContext['lending']>[number]

/** Said beside DeFindex's figure, because it is not the same kind of number as Blend's. */
export const DEFINDEX_RATE_BASIS = '7-day trailing, net of vault fees'

export interface FetchLendingRatesOptions {
  /** Decides which venues are read at all. Tests pass one; production reads the process. */
  env?: Env
  /** Injected in tests. */
  readBlend?: () => Promise<Reserve>
  readDefindex?: (symbol: string) => Promise<DefindexRate | undefined>
}

/**
 * Dollar rates for the currencies the app's bonds settle in, and for gold.
 *
 * Silent on failure, like every other read here: a competition without a
 * peso rate is a competition where agents cannot value CETES, which is
 * worse than none of them proposing it — but not worse than no competition.
 */
async function fetchFxRates(): Promise<Record<string, MarketPrice>> {
  try {
    return await fetchFxPrices()
  } catch {
    return {}
  }
}

/**
 * Live supply rates from every lending venue this deployment can reach.
 *
 * Each venue fails on its own and silently. A competition should not
 * collapse because a lending pool was unreachable — the trade is still the
 * main event — and one venue being down is no reason to hide the other's
 * rate. An agent given no rate for a venue simply will not propose it.
 *
 * DeFindex is asked about each asset it maps to a vault. The read declines
 * on its own when the vault holds a different asset from the one this app
 * trades, which is what its USDC vault does.
 */
export async function fetchLendingRates(
  options: FetchLendingRatesOptions = {}
): Promise<LendingRate[]> {
  const env = options.env ?? process.env
  const offered = configuredLendingVenues(env)
  const readBlend = options.readBlend ?? (() => readReserve(BLEND_XLM))
  const readDefindex =
    options.readDefindex ?? ((symbol: string) => readDefindexRate(symbol, { env }))

  const blend: Promise<LendingRate[]> = offered.includes('blend')
    ? readBlend()
        .then((reserve) => [
          {
            venue: 'blend',
            asset: 'XLM',
            supplyApy: Number(reserve.supplyApy.toFixed(2)),
            utilisation: Number((reserve.utilisation * 100).toFixed(2)),
          },
        ])
        .catch(() => [])
    : Promise.resolve([])

  const defindex: Promise<LendingRate[]> = offered.includes('defindex')
    ? Promise.all(
        Object.keys(VAULT_KEYS).map((symbol) =>
          readDefindex(symbol)
            .then((rate): LendingRate[] =>
              rate === undefined
                ? []
                : [
                    {
                      venue: 'defindex',
                      asset: symbol,
                      supplyApy: Number(rate.apy.toFixed(2)),
                      basis: DEFINDEX_RATE_BASIS,
                    },
                  ]
            )
            .catch(() => [])
        )
      ).then((all) => all.flat())
    : Promise.resolve([])

  const [fromBlend, fromDefindex] = await Promise.all([blend, defindex])
  return [...fromBlend, ...fromDefindex]
}

/**
 * Live withdrawal limits from each anchor. Silent on failure, like lending
 * rates: an agent given no limits will not propose an offramp, which is the
 * safe reading of "the anchor could not be reached".
 *
 * Anchors requiring a `client_domain` (MoneyGram today) are excluded: this
 * deployment has none, so it never reads limits for — and can never offer —
 * an anchor it cannot complete a withdrawal through.
 */
async function fetchOfframpLimits(): Promise<NonNullable<MarketContext['offramps']>> {
  const out: NonNullable<MarketContext['offramps']> = []
  // Only anchors on this network: on mainnet with none configured the list
  // is empty, and the agents propose no off-ramp at all.
  const anchors = anchorsOn()
    .map((id) => anchorOn(id))
    .filter((a): a is AnchorEntry => a !== undefined && !a.requiresClientDomain)
  await Promise.all(
    anchors.map(async (anchor) => {
      try {
        const toml = await readAnchorToml(anchor)
        const limits = await readWithdrawInfo(toml, 'USDC')
        if (limits === undefined || !limits.enabled) return
        out.push({
          venue: anchor.id,
          asset: 'USDC',
          ...(limits.minAmount !== undefined ? { minAmount: limits.minAmount } : {}),
          ...(limits.maxAmount !== undefined ? { maxAmount: limits.maxAmount } : {}),
          feeEnabled: limits.feeEnabled,
        })
      } catch {
        // Left out. The agent reasons without it.
      }
    })
  )
  return out
}

export function buildMarketContext(
  chain: string,
  env: Env = process.env,
  network: StellarNetworkName = activeNetwork()
): MarketContext {
  // An unrecognised slug used to fall through to 'evm', which quietly handed
  // the agents Curve and Uniswap on a Stellar competition — venues that do not
  // exist here and cannot be executed against. A stale client bundle sending
  // an empty slug was enough to trigger it, and the proposals that came back
  // read as plausible nonsense rather than as an error.
  //
  // No chain means no venues. An agent with nothing to choose from is a
  // visible failure; an agent choosing Uniswap on Stellar is an invisible one.
  const family = isChainSlug(chain) ? CHAIN_DESCRIPTORS[chain].family : undefined
  // A lending venue this deployment cannot reach is absent, not listed and
  // failing later. DeFindex needs a key; without one it does not exist here.
  const lendingOffered: string[] = configuredLendingVenues(env, network)

  return {
    asOf: new Date().toISOString(),
    prices: { ...REFERENCE_PRICES_USD },
    // What the agent may actually trade, with a plain-English description of
    // each. Without this an agent has no way to know tokenized sovereign debt
    // is on the menu, and would reason only about the currencies it has seen
    // in prior prompts.
    assets: tradeableSymbols().map((code) => ({
      code,
      what: verificationOf(code)?.description ?? code,
      // How well the issuer is established. An agent weighing an unfamiliar
      // asset should know whether the organisation named actually confirms it
      // issued the thing, and the difference is invisible from a ticker.
      trust: trustSummary(code) ?? 'Verification unknown.',
    })),
    // Naming a venue that does not exist on the active chain is a plausible
    // failure for a model, so the list it may choose from is filtered here
    // rather than validated after the fact.
    venues: venues
      .filter((v) => family !== undefined && v.family === family)
      // And on this network. A Stellar venue whose mainnet contracts are not
      // verified is testnet-only, and an agent must not be offered it.
      .filter((v) => v.family !== 'stellar' || isVenueOn(v, network))
      // Anchors are follow-on destinations, named through `thenVenue` and
      // validated against the anchor registry; they are not places a trade
      // executes and must not be selectable as a swap venue.
      .filter((v) => v.category !== 'offramp')
      .filter((v) => v.category !== 'lending' || lendingOffered.includes(v.id))
      // A perps venue is not a swap venue either. Its figures reach the
      // agents as facts under `perps`; a proposal naming it would pass
      // validation and reach a builder with no way to open a position.
      .filter((v) => v.category !== 'perps')
      // Nor is a name service: it resolves recipients, it fills nothing.
      .filter((v) => v.category !== 'names')
      .map((v) => ({ id: v.id, name: v.name, category: v.category })),
    // Static until a feed exists. Stated plainly so the prompt is not implying
    // a signal the app does not actually have.
    volatilityHint: 'normal',
    gasHint: 'normal',
  }
}
