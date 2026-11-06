import type { Venue } from '@intent/types'

export const walrusListing: Venue = {
  id: 'walrus',
  family: 'sui',
  name: 'Walrus',
  category: 'staking',
  chains: ['Sui'],
  url: 'https://docs.wal.app',
  bestFor: 'Earning on WAL with a storage node. Getting out takes one to two 14-day epochs',
  integration: 'executes',
  capability: 'Stakes WAL with a storage node and unstakes it',
}
