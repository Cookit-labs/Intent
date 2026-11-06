import type { Venue } from '@intent/types'

export const rheaDexListing: Venue = {
  id: 'rhea-dex',
  family: 'near',
  name: 'Rhea DEX',
  category: 'swap',
  chains: ['NEAR'],
  url: 'https://rhea.finance',
  bestFor: 'The main on-chain DEX on NEAR, swapping straight from its own pools',
  integration: 'executes',
  capability:
    'Swaps NEAR, USDC and USDT on its pools, with what you receive sent straight to your wallet. Also takes back anything held for you at Rhea, and turns wNEAR back into NEAR. Mainnet only. No swap has been signed through this app yet.',
}

export const rheaLendListing: Venue = {
  id: 'rhea-lend',
  family: 'near',
  name: 'Rhea Lend',
  category: 'lending',
  chains: ['NEAR'],
  url: 'https://rhea.finance',
  bestFor: 'Lending on NEAR. Exploited for about $18.4M in April 2026, and exits can be limited',
  integration: 'executes',
  capability:
    'Supplies, withdraws, borrows and repays NEAR, USDC and USDT, and refuses a loan your supply cannot safely back. A loan can be liquidated. Withdrawals are limited by what borrowers leave free. Mainnet only. Nothing has been signed through this app yet.',
}
