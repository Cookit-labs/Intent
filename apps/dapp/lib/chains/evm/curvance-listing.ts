import type { Venue } from '@intent/types'

export const curvanceListing: Venue = {
  id: 'curvance',
  family: 'evm',
  name: 'Curvance',
  category: 'lending',
  chains: ['Monad'],
  url: 'https://app.curvance.com',
  bestFor: 'Lending USDC in an isolated market against WMON, at a variable rate',
  integration: 'executes',
  capability: 'Supplies and withdraws USDC and shows the current rate',
}
