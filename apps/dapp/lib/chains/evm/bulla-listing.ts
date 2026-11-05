import type { Venue } from '@intent/types'

export const bullaListing: Venue = {
  id: 'bulla',
  family: 'evm',
  name: 'Bulla',
  category: 'payments',
  chains: ['Avalanche'],
  url: 'https://www.bulla.network',
  bestFor: 'Invoices held onchain, billed and paid from your own wallet',
  integration: 'executes',
  capability: 'Bills and pays invoices in USDC and USDT',
}
