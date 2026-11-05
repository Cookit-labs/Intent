import type { MarketPrice } from '../swap/price-types'

/**
 * Dollars for an amount of an asset in display units, from a price table;
 * `NaN` when the table has no real price for it. A fallback entry is a guess,
 * so it counts as no price.
 */
export function usdValue(
  symbol: string,
  amount: string,
  prices: Record<string, MarketPrice>
): number {
  const price = prices[symbol]
  if (price === undefined || price.source === 'fallback') return Number.NaN
  return Number(amount) * price.usd
}
