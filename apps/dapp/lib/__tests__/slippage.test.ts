import { describe, expect, it } from 'vitest'

import { DEFAULT_SLIPPAGE_BPS } from '../swap/build-tx'
import { MAX_SLIPPAGE_BPS, checkSlippageBps } from '../swap/slippage'

/**
 * The client may ask for a tolerance; the server decides how much is too much.
 * At 10 000 bps `destMin` is zero and the network fills the swap at any price.
 */

describe('the slippage ceiling', () => {
  it('sits above the default, or the default would be refused', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBeLessThanOrEqual(MAX_SLIPPAGE_BPS)
  })

  it('accepts nothing, null, zero, and anything up to the ceiling', () => {
    expect(checkSlippageBps(undefined)).toEqual({ ok: true, bps: undefined })
    expect(checkSlippageBps(null)).toEqual({ ok: true, bps: undefined })
    expect(checkSlippageBps(0)).toEqual({ ok: true, bps: 0 })
    expect(checkSlippageBps(MAX_SLIPPAGE_BPS)).toEqual({ ok: true, bps: MAX_SLIPPAGE_BPS })
  })

  it('refuses a tolerance above the ceiling, naming it', () => {
    const out = checkSlippageBps(MAX_SLIPPAGE_BPS + 1)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain(String(MAX_SLIPPAGE_BPS))
  })

  it('refuses a value that is not a whole non-negative number', () => {
    for (const bad of ['50', 12.5, -1, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(checkSlippageBps(bad).ok, String(bad)).toBe(false)
    }
  })
})
