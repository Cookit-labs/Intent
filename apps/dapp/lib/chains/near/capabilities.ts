import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const nearCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Rhea DEX', symbol: 'NEAR', then: ['supply', 'send'] },
  { kind: 'stake', venue: 'Meta Pool', symbol: 'NEAR' },
  { kind: 'stake', venue: 'rNEAR', symbol: 'NEAR' },
  { kind: 'unstake', venue: 'Meta Pool', symbol: 'stNEAR' },
  { kind: 'unstake', venue: 'rNEAR', symbol: 'rNEAR' },
  { kind: 'claim', venue: 'Meta Pool', symbol: 'NEAR' },
  { kind: 'supply', venue: '1Click Earn', symbol: 'USDC' },
  { kind: 'withdraw', venue: '1Click Earn', symbol: 'USDC' },
  { kind: 'supply', venue: 'Rhea Lend', symbol: 'USDC' },
  { kind: 'withdraw', venue: 'Rhea Lend', symbol: 'USDC' },
  { kind: 'borrow', venue: 'Rhea Lend', symbol: 'USDC' },
  { kind: 'repay', venue: 'Rhea Lend', symbol: 'USDC' },
]
