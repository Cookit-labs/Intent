import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const solanaCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Jupiter', symbol: 'SOL', then: ['cashout', 'supply', 'send'] },
  { kind: 'supply', venue: 'Jupiter Lend', symbol: 'USDC' },
  { kind: 'withdraw', venue: 'Jupiter Lend', symbol: 'USDC' },
  { kind: 'supply', venue: 'Kamino Lend', symbol: 'USDC' },
  { kind: 'borrow', venue: 'Kamino Lend', symbol: 'USDC' },
  { kind: 'repay', venue: 'Kamino Lend', symbol: 'USDC' },
  { kind: 'stake', venue: 'Jito', symbol: 'SOL' },
  { kind: 'unstake', venue: 'Jito', symbol: 'JitoSOL' },
  { kind: 'claim', venue: 'Solayer', symbol: 'SOL' },
]
