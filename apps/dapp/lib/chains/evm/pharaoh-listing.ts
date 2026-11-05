import type { Venue } from '@intent/types'

export const pharaohVenue: Venue = {
  id: 'pharaoh',
  family: 'evm',
  name: 'Pharaoh',
  category: 'swap',
  chains: ['Avalanche'],
  url: 'https://www.phar.gg',
  bestFor:
    'Swaps from the concentrated-liquidity pool on Avalanche that pays most for the size, priced on chain',
  integration: 'executes',
  capability: 'Swaps AVAX, WAVAX, USDC and USDT. Pays out WAVAX, not AVAX',
}
