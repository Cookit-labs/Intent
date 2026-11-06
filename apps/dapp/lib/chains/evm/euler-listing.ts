import type { Venue } from '@intent/types'

export const eulerMonadListing: Venue = {
  id: 'euler-monad',
  family: 'evm',
  name: 'Euler',
  category: 'lending',
  chains: ['Monad'],
  url: 'https://app.euler.finance',
  bestFor: 'Earning on USDC lent against FXRP in a vault curated by Clearstar',
  integration: 'executes',
  capability:
    'Supplies and withdraws USDC in the Clearstar Reactor vault, and shows the current rate',
}

export const eulerAvalancheListing: Venue = {
  id: 'euler-avalanche',
  family: 'evm',
  name: 'Euler',
  category: 'lending',
  chains: ['Avalanche'],
  url: 'https://app.euler.finance',
  bestFor:
    'Earning on USDC in a small vault curated by 9 Summits, with none of Stream’s tokens as collateral',
  integration: 'executes',
  capability: 'Supplies and withdraws USDC in the 9 Summits vault, and shows the current rate',
}
