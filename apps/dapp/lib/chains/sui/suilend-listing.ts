import type { Venue } from '@intent/types'

export const suilendListing: Venue = {
  id: 'suilend',
  family: 'sui',
  name: 'Suilend',
  category: 'lending',
  chains: ['Sui'],
  url: 'https://suilend.fi',
  bestFor: 'Lending in the largest market on Sui, under new ownership since June 2026',
  integration: 'executes',
  capability:
    'Supplies USDC, withdraws, borrows and repays, and shows the base rate. Refuses a loan your supply cannot safely back',
}
