import type { MarketPrice } from './price-types'

/**
 * The browser's way to ask what an asset is worth.
 *
 * `fetchMarketPrices` reaches Reflector through the Stellar SDK and is
 * server-only for that reason; this fetches the route that runs it. The
 * route degrades source by source and always answers for XLM — Reflector,
 * then the mainnet book, then a labelled fallback — so an empty table here
 * means the route itself was unreachable, and that is thrown rather than
 * papered over. A `useQuery` caller keeps its last good data on a throw; a
 * bare fallback returned from here would look like a quote and be nothing of
 * the kind.
 */
export async function fetchMarketPricesFromRoute(): Promise<Record<string, MarketPrice>> {
  const res = await fetch('/api/prices/market')
  if (!res.ok) throw new Error('could not read market prices')

  const body = (await res.json()) as { prices?: Record<string, MarketPrice> }
  return body.prices ?? {}
}
