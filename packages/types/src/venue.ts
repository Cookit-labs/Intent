import type { ChainFamily } from './chain'

export type VenueCategory = 'swap' | 'aggregator' | 'orderbook'

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
}
