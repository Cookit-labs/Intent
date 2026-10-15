import type { ReadingForIntent } from './parse-intent'

const STYLES = ['market', 'limit', 'accumulate', 'hedge', 'rebalance', 'route_liquidity'] as const
const AMOUNT_OF = ['sent', 'received'] as const

/**
 * A reading the chat sent to the competition, or undefined when it is absent or
 * not usable. Checked rather than trusted: it arrives from the browser, and an
 * unusable one falls back to reading the words.
 */
export function readingFromBody(value: unknown, text: string): ReadingForIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  const style = STYLES.find((known) => known === r['style'])
  if (
    typeof r['tokenIn'] !== 'string' ||
    typeof r['tokenOut'] !== 'string' ||
    typeof r['amount'] !== 'number' ||
    !Number.isFinite(r['amount']) ||
    r['amount'] <= 0 ||
    style === undefined
  ) {
    return undefined
  }
  const amountOf = AMOUNT_OF.find((known) => known === r['amountOf'])
  return {
    text,
    tokenIn: r['tokenIn'],
    tokenOut: r['tokenOut'],
    amount: r['amount'],
    amountIsUsd: r['amountIsUsd'] === true,
    ...(amountOf !== undefined ? { amountOf } : {}),
    style,
    ...(typeof r['limitPriceUsd'] === 'number' && r['limitPriceUsd'] > 0
      ? { limitPriceUsd: r['limitPriceUsd'] }
      : {}),
  }
}
