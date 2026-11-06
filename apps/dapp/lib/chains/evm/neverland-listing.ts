import type { Venue } from '@intent/types'

export const neverlandListing: Venue = {
  id: 'neverland',
  family: 'evm',
  name: 'Neverland',
  category: 'lending',
  chains: ['Monad'],
  url: 'https://app.neverland.money',
  bestFor: 'A smaller Monad lending market built from Aave V3’s code, at variable rates',
  integration: 'executes',
  capability:
    'Supplies, withdraws, borrows at a variable rate, and repays USDC and USDT0 in its main market',
}
