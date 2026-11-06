import type { Venue } from '@intent/types'

export const streamflowVenue: Venue = {
  id: 'streamflow',
  family: 'solana',
  name: 'Streamflow',
  category: 'payments',
  chains: ['Solana'],
  url: 'https://app.streamflow.finance',
  // Listed, as 1Click is: whether this runs depends on a secret this client-safe file can't read.
  bestFor:
    'Paying someone hour by hour over a set number of days, funded up front. Costs a fee in SOL, shown before you sign',
}
