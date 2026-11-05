import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const avalancheCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'NEAR Intents 1Click', symbol: 'AVAX' },
]

export const monadCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'NEAR Intents 1Click', symbol: 'MON' },
]
