import type { Venue } from '@intent/types'

export const momentumListing: Venue = {
  id: 'momentum',
  family: 'sui',
  name: 'Momentum',
  category: 'swap',
  chains: ['Sui'],
  url: 'https://app.mmt.finance/trade',
  bestFor: 'Direct swaps in concentrated-liquidity pools',
  integration: 'executes',
  capability: 'Swaps SUI, USDC and USDT in its SUI/USDC and USDT/USDC pools',
}
