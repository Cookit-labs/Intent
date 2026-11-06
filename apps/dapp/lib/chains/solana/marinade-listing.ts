import type { Venue } from '@intent/types'

/** Client-safe: no chain SDK. */
export const marinadeListing: Venue = {
  id: 'marinade',
  family: 'solana',
  name: 'Marinade',
  category: 'staking',
  chains: ['Solana'],
  bestFor: 'Liquid staking SOL for mSOL, with an instant exit through its own pool for a fee',
  url: 'https://marinade.finance',
  integration: 'executes',
  capability:
    'Stakes SOL for mSOL and unstakes mSOL straight away through Marinade’s pool, showing the fee read on chain. No yearly rate is shown. Native staking and delayed unstake aren’t wired here.',
}
