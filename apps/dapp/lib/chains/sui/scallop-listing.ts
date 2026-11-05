import type { Venue } from '@intent/types'

export const scallopListing: Venue = {
  id: 'scallop',
  family: 'sui',
  name: 'Scallop',
  category: 'lending',
  chains: ['Sui'],
  url: 'https://scallop.io',
  bestFor: 'Lending with a small USDC pool. A retired contract lost about $142K in April 2026',
  integration: 'executes',
  capability:
    'Supplies and withdraws USDC and shows the base rate. Borrows and repays on a loan position you already have, not a staked one',
}
