import type { Venue } from '@intent/types'

export const beefyMonadListing: Venue = {
  id: 'beefy-monad',
  family: 'evm',
  name: 'Beefy',
  category: 'savings',
  chains: ['Monad'],
  url: 'https://app.beefy.com/vault/aavev3-monad-usdc',
  bestFor: 'Earning on USDC through Aave on Monad, with rewards reinvested for you',
  integration: 'executes',
  capability: 'Supplies and withdraws USDC and shows the current rate',
}
