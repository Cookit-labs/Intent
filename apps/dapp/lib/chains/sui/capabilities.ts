import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const suiCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Cetus', symbol: 'SUI', then: ['cashout', 'supply', 'send'] },
  { kind: 'supply', venue: 'NAVI', symbol: 'USDC' },
  { kind: 'stake', venue: 'SpringSui', symbol: 'SUI' },
]
