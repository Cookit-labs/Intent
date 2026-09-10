import type { IntentType } from '@intent/types'

export const INTENT_TYPES: { value: IntentType; label: string; hint: string }[] = [
  // "Swap" rather than "Market buy"/"Market sell": both are a swap between
  // two assets executed at the going rate, and the direction is already
  // visible in the amounts on the row. Matches "Limit swap" below, so the
  // only distinction the label draws is the one that matters — whether the
  // order waits for a price.
  { value: 'market_buy', label: 'Swap', hint: 'Acquire now at best available price' },
  { value: 'market_sell', label: 'Swap', hint: 'Sell now at best available price' },
  // "Limit swap" rather than "Limit buy"/"Limit sell": every one of these is
  // a swap between two assets, and the direction is already visible in the
  // amounts on the row. The type still distinguishes them internally, because
  // a buy and a sell trigger on opposite sides of the price.
  { value: 'limit_buy', label: 'Limit swap', hint: 'Buy only at or below a target price' },
  { value: 'limit_sell', label: 'Limit swap', hint: 'Sell only at or above a target price' },
  { value: 'accumulate', label: 'Limit swap', hint: 'Build a position over time (TWAP-style)' },
  { value: 'hedge', label: 'Hedge', hint: 'Offset exposure on an existing position' },
  { value: 'rebalance', label: 'Rebalance', hint: 'Shift allocation between assets' },
  { value: 'route_liquidity', label: 'Route liquidity', hint: 'Best cross-venue routing' },
]

export const TOKENS = ['USDC', 'USDT', 'WETH', 'ARB', 'WBTC'] as const

export function intentTypeLabel(type: IntentType): string {
  return INTENT_TYPES.find((t) => t.value === type)?.label ?? type
}
