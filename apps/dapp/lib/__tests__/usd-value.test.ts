import { describe, expect, it } from 'vitest'

import { usdValue } from '../server/usd-value'
import type { MarketPrice } from '../swap/price-types'

const table = {
  XLM: { usd: 0.2, source: 'reflector' },
  USDC: { usd: 1, source: 'reflector' },
  CETES: { usd: 0.05, source: 'fallback' },
} as unknown as Record<string, MarketPrice>

describe('valuing an amount', () => {
  it('multiplies display units by a real price', () => {
    expect(usdValue('XLM', '100', table)).toBeCloseTo(20)
    expect(usdValue('USDC', '12.5', table)).toBe(12.5)
  })

  it('has no value for a fallback price or an unknown asset', () => {
    expect(usdValue('CETES', '100', table)).toBeNaN()
    expect(usdValue('DOGE', '1', table)).toBeNaN()
  })
})
