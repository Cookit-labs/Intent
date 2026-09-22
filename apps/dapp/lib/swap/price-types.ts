/**
 * The shape of a price, separated from the code that fetches one.
 *
 * `prices.ts` reaches Reflector through the Stellar SDK, which makes it a
 * server-only module — importing it from a `'use client'` hook would pull the
 * SDK into the browser bundle for the sake of a type and a one-line helper.
 * Browser code imports the shape from here and fetches the numbers from a
 * route.
 */

/**
 * Where a figure came from, so a stale or missing price is attributable.
 *
 * Ordered by how much the app should trust it as an answer to "what is this
 * worth": Reflector aggregates CEX and DEX venues; a single order book is one
 * venue; the fallback is a hardcoded guess and must say so.
 */
export type PriceSource = 'reflector' | 'stellar-mainnet' | 'stellar-testnet' | 'fallback'

export interface MarketPrice {
  symbol: string
  usd: number
  source: PriceSource
  /** When the figure was taken — the oracle's own timestamp where it has one. */
  asOf: string
}

/** Flattens to the `symbol -> usd` shape `MarketContext.prices` expects. */
export function toPriceTable(prices: Record<string, MarketPrice>): Record<string, number> {
  return Object.fromEntries(Object.entries(prices).map(([sym, p]) => [sym, p.usd]))
}
