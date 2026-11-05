import type { Venue } from '@intent/types'

function listing(chain: 'avalanche' | 'monad', chainName: string, symbols: string): Venue {
  return {
    id: `uniswap-${chain}`,
    family: 'evm',
    name: 'Uniswap',
    category: 'swap',
    chains: [chainName],
    url: 'https://app.uniswap.org',
    bestFor: 'Swaps from the v3 pool that pays most for the size, priced on chain',
    integration: 'executes',
    capability: `Swaps ${symbols}. Pays out the wrapped coin, not the native one`,
  }
}

export const uniswapAvalancheVenue = listing('avalanche', 'Avalanche', 'AVAX, WAVAX, USDC and USDT')

export const uniswapMonadVenue = listing('monad', 'Monad', 'MON, WMON, USDC and USDT0')
