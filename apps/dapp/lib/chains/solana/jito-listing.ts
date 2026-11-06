import type { Venue } from '@intent/types'

/** Client-safe: no chain SDK. */
export const jitoListing: Venue = {
  id: 'jito',
  family: 'solana',
  name: 'Jito',
  category: 'staking',
  chains: ['Solana'],
  bestFor: 'Minting JitoSOL directly from its stake pool, with no market in between',
  url: 'https://www.jito.network',
  integration: 'executes',
  capability:
    'Stakes SOL for JitoSOL and unstakes JitoSOL for SOL from the pool’s reserve, at the rate read on chain. No yearly rate is shown.',
}
