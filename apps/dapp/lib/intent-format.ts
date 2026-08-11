import type { IntentType } from '@intent/types'

export const INTENT_TYPES: { value: IntentType; label: string; hint: string }[] = [
  { value: 'market_buy', label: 'Market buy', hint: 'Acquire now at best available price' },
  { value: 'market_sell', label: 'Market sell', hint: 'Sell now at best available price' },
  { value: 'limit_buy', label: 'Limit buy', hint: 'Buy only at or below a target price' },
  { value: 'limit_sell', label: 'Limit sell', hint: 'Sell only at or above a target price' },
  { value: 'accumulate', label: 'Accumulate', hint: 'Build a position over time (TWAP-style)' },
  { value: 'hedge', label: 'Hedge', hint: 'Offset exposure on an existing position' },
  { value: 'rebalance', label: 'Rebalance', hint: 'Shift allocation between assets' },
  { value: 'route_liquidity', label: 'Route liquidity', hint: 'Best cross-venue routing' },
]

export const TOKENS = ['USDC', 'USDT', 'WETH', 'ARB', 'WBTC'] as const

export function intentTypeLabel(type: IntentType): string {
  return INTENT_TYPES.find((t) => t.value === type)?.label ?? type
}
