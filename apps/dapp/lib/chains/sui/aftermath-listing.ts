import type { Venue } from '@intent/types'

export const aftermathListing: Venue = {
  id: 'aftermath',
  family: 'sui',
  name: 'Aftermath',
  category: 'staking',
  chains: ['Sui'],
  url: 'https://aftermath.finance',
  bestFor:
    'Liquid staking with afSUI, with SUI back at the next epoch. Its perps lost about $1.14M in April 2026; those are separate and not used here',
  integration: 'executes',
  capability: 'Stakes SUI for afSUI, and unstakes afSUI by the next epoch',
}
