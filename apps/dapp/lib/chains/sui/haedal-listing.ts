import type { Venue } from '@intent/types'

export const haedalListing: Venue = {
  id: 'haedal',
  family: 'sui',
  name: 'Haedal',
  category: 'staking',
  chains: ['Sui'],
  url: 'https://www.haedal.xyz',
  bestFor:
    'Liquid staking with haSUI and an instant way out. Its vaults reportedly lost about $915K in June 2026; those are separate and not used here',
  integration: 'executes',
  capability: 'Stakes SUI for haSUI, and unstakes haSUI right away for a small fee',
}
