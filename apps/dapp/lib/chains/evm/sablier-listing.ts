import type { Venue } from '@intent/types'

function listed(id: string, chain: string, tokens: string): Venue {
  return {
    id,
    family: 'evm',
    name: 'Sablier',
    category: 'payments',
    chains: [chain],
    url: 'https://app.sablier.com',
    bestFor: 'Paying someone second by second over a set number of days, funded up front',
    integration: 'executes',
    capability: `Streams ${tokens} to an address you type, and you can cancel the unstreamed part`,
  }
}

export const sablierVenues: Venue[] = [
  listed('sablier-avalanche', 'Avalanche', 'USDC and USDT'),
  listed('sablier-monad', 'Monad', 'USDC and USDT0'),
]
