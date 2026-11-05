import type { Venue } from '@intent/types'

/** Client-safe: no chain SDK. */
export const solayerListing: Venue = {
  id: 'solayer',
  family: 'solana',
  name: 'Solayer',
  category: 'staking',
  chains: ['Solana'],
  bestFor: 'Restaking SOL for sSOL. Much smaller than it was, and leaving takes about two days',
  url: 'https://solayer.org',
  integration: 'executes',
  capability:
    'Restakes SOL for sSOL. Unstaking sSOL gives you a stake account of your own that cools down first, then "claim my SOL" pays the SOL to your wallet. sSOL only, not sUSD, Pay, the card or the chain.',
}
