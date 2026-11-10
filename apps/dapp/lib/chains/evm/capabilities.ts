import type { ChainCapability } from '../explain'

/** What actually works here, for telling someone who asked for something else. Client-safe. */
export const avalancheCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Uniswap', symbol: 'AVAX', then: ['cashout', 'supply', 'send'] },
  { kind: 'limit', venue: 'CoW Protocol', symbol: 'AVAX' },
  { kind: 'supply', venue: 'Aave', symbol: 'USDC' },
  { kind: 'withdraw', venue: 'Aave', symbol: 'USDC' },
  { kind: 'borrow', venue: 'Aave', symbol: 'USDC' },
  { kind: 'repay', venue: 'Aave', symbol: 'USDC' },
  { kind: 'stream', venue: 'Sablier', symbol: 'USDC' },
  { kind: 'invoice', venue: 'Bulla', symbol: 'USDC' },
  { kind: 'pay_invoice', venue: 'Bulla', symbol: 'USDC' },
]

export const monadCapabilities: ChainCapability[] = [
  { kind: 'swap', venue: 'Uniswap', symbol: 'MON', then: ['supply', 'send'] },
  { kind: 'supply', venue: 'Aave', symbol: 'USDC' },
  { kind: 'withdraw', venue: 'Aave', symbol: 'USDC' },
  { kind: 'borrow', venue: 'Aave', symbol: 'USDC' },
  { kind: 'repay', venue: 'Aave', symbol: 'USDC' },
  { kind: 'stake', venue: 'FastLane', symbol: 'MON' },
  { kind: 'unstake', venue: 'FastLane', symbol: 'shMON' },
  { kind: 'stream', venue: 'Sablier', symbol: 'USDC' },
]
