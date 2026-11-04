import type { Venue } from '@intent/types'

const ONECLICK_DOCS =
  'https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api'

// Listed, as Lulo is on Solana: whether this runs depends on a secret this client-safe file can't read.
export const evmVenues: Venue[] = [
  {
    id: '1click-avalanche',
    family: 'evm',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: ['Avalanche'],
    url: ONECLICK_DOCS,
    bestFor: 'Swaps between AVAX, USDC and USDT, priced by competing market makers',
  },
  {
    id: '1click-monad',
    family: 'evm',
    name: 'NEAR Intents 1Click',
    category: 'swap',
    chains: ['Monad'],
    url: ONECLICK_DOCS,
    bestFor: 'Swaps between MON, USDC and USDT0, priced by competing market makers',
  },
]
