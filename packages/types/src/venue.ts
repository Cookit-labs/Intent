import type { ChainFamily } from './chain'

export type VenueCategory =
  | 'swap'
  | 'aggregator'
  | 'orderbook'
  | 'lending'
  | 'rwa'
  | 'pool'
  | 'offramp'

/**
 * How far a venue is wired into the app.
 *
 * The Apps page listed venues as links, which said nothing about whether the
 * app could actually use one. That distinction is the interesting part: a user
 * seeing Soroswap and Phoenix side by side has no way to tell that intents
 * route through the first and merely mention the second.
 *
 * - `executes`  — the app builds, signs and submits transactions here.
 * - `quotes`    — priced for comparison, but nothing can be signed yet.
 * - `listed`    — a venue on this chain the app does not integrate.
 */
export type VenueIntegration = 'executes' | 'quotes' | 'listed'

export interface Venue {
  id: string
  /**
   * Which chain world the venue trades on. Stellar venues (Soroswap, Aquarius)
   * and EVM venues (Uniswap, CoW) are not interchangeable, so the Apps screen
   * filters by this rather than showing every venue on every chain.
   */
  family: ChainFamily
  name: string
  category: VenueCategory
  chains: string[]
  bestFor: string
  url: string
  /**
   * Defaults to `listed` where absent: a venue nobody has wired in is exactly
   * that, and claiming otherwise by omission would be the wrong default.
   */
  integration?: VenueIntegration
  /** What the app can do here, in a few words. Shown only when integrated. */
  capability?: string
}
