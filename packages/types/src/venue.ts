export type VenueCategory = 'swap' | 'aggregator' | 'orderbook'

export interface Venue {
  id: string
  name: string
  category: VenueCategory
  chains: string[]
  bestFor: string
  url: string
}
