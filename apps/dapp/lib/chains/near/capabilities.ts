import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const nearCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'NEAR Intents', symbol: 'NEAR', then: ['supply', 'send'] },
  { kind: 'stake', venue: 'Meta Pool', symbol: 'NEAR' },
  { kind: 'stake', venue: 'rNEAR', symbol: 'NEAR' },
  { kind: 'supply', venue: '1Click Earn', symbol: 'USDC' },
]
