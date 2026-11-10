import { fetchLendingRates, type LendingRate } from '../agents/market-context'
import { quoteChainRoutes, type ChainRouteQuote } from '../agents/chain-routes'
import type { QuotedRoute } from '../agents/brain'
import { chainModule } from '../chains/registry'
import type { ChainActionRequest, ChainModule } from '../chains/types'
import type { VenueYield } from '../chat/yield-reply'

const STELLAR_VENUE_NAME: Record<string, string> = { blend: 'Blend', defindex: 'DeFindex' }

export interface LiveYieldDeps {
  lendingRates: () => Promise<LendingRate[]>
  chainModule: (chain: string) => ChainModule | undefined
  quoteRoutes: (
    chainApi: ChainModule,
    request: ChainActionRequest,
    account: string
  ) => Promise<QuotedRoute[]>
}

const DEFAULT_DEPS: LiveYieldDeps = {
  lendingRates: () => fetchLendingRates(),
  chainModule,
  quoteRoutes: quoteChainRoutes,
}

/** The best figure each venue gave, so a venue quoting twice is listed once. */
function bestPerVenue(rates: VenueYield[]): VenueYield[] {
  const best = new Map<string, VenueYield>()
  for (const rate of rates) {
    const held = best.get(rate.venueName)
    if (held === undefined || rate.apyPercent > held.apyPercent) best.set(rate.venueName, rate)
  }
  return [...best.values()]
}

/**
 * What each venue on a chain pays to supply an asset, read now. Off Stellar this is the same live
 * quote the agent race reads, so it costs nothing and leaves nothing behind. A venue that gives no
 * figure is left out rather than shown as zero.
 */
export async function liveYields(
  chain: string,
  asset: string,
  account: string | undefined,
  deps: LiveYieldDeps = DEFAULT_DEPS
): Promise<VenueYield[]> {
  const symbol = asset.trim().toUpperCase()
  if (chain === 'stellar') {
    const rates = await deps.lendingRates().catch(() => [])
    return bestPerVenue(
      rates
        .filter((r) => r.asset.toUpperCase() === symbol)
        .map((r) => ({
          venueName: STELLAR_VENUE_NAME[r.venue] ?? r.venue,
          apyPercent: r.supplyApy,
        }))
    )
  }
  const chainApi = deps.chainModule(chain)
  if (chainApi === undefined || account === undefined || account === '') return []
  const routes = await deps
    .quoteRoutes(chainApi, { kind: 'supply', amount: '1', tokenIn: symbol }, account)
    .catch(() => [])
  return bestPerVenue(
    routes.flatMap((route) => {
      const quote = route.quote as Partial<ChainRouteQuote> | undefined
      return quote?.venueName !== undefined && quote.apyPercent !== undefined
        ? [{ venueName: quote.venueName, apyPercent: quote.apyPercent }]
        : []
    })
  )
}
