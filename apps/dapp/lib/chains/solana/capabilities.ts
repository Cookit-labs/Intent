import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const solanaCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Jupiter', symbol: 'SOL', then: ['cashout', 'supply', 'send'] },
  { kind: 'supply', venue: 'Jupiter Lend', symbol: 'USDC' },
  { kind: 'limit', venue: 'Kamino', symbol: 'SOL' },
]
