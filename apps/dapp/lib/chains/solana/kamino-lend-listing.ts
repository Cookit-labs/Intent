import type { Venue } from '@intent/types'

/** Client-safe: no chain SDK. */
export const kaminoLendListing: Venue = {
  id: 'kamino-lend',
  family: 'solana',
  name: 'Kamino Lend',
  category: 'lending',
  chains: ['Solana'],
  bestFor: 'Borrowing against what you supply, which a Kamino Earn vault can’t do',
  url: 'https://kamino.com',
  integration: 'executes',
  capability:
    'Supplies, withdraws, borrows and repays on Kamino’s main lending market, built directly against its program, with live rates and limits read on chain.',
}
