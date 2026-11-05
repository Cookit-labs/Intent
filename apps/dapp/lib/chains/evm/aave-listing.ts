import type { Venue } from '@intent/types'

const CAPABILITY =
  'Supplies, withdraws, borrows at a variable rate, and repays, from your own wallet'

export const aaveListings: Venue[] = [
  {
    id: 'aave-avalanche',
    family: 'evm',
    name: 'Aave',
    category: 'lending',
    chains: ['Avalanche'],
    url: 'https://app.aave.com',
    bestFor: 'Lending and borrowing in Avalanche’s largest market, at variable rates',
    integration: 'executes',
    capability: CAPABILITY,
  },
  {
    id: 'aave-monad',
    family: 'evm',
    name: 'Aave',
    category: 'lending',
    chains: ['Monad'],
    url: 'https://app.aave.com',
    bestFor: 'Lending and borrowing in Monad’s largest market, at variable rates',
    integration: 'executes',
    capability: CAPABILITY,
  },
]
