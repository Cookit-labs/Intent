import type { Venue } from '@intent/types'

export const deepbookListing: Venue = {
  id: 'deepbook',
  family: 'sui',
  name: 'DeepBook',
  category: 'orderbook',
  chains: ['Sui'],
  url: 'https://www.deepbook.tech',
  bestFor: "Swaps straight against Sui's on-chain order book",
  integration: 'executes',
  capability:
    'Swaps SUI, USDC and USDsui at market, and USDT when its thin book can fill. Limit orders are listed apart, as DeepBook Limit Orders',
}
