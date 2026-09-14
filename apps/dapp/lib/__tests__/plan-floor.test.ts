import { describe, expect, it } from 'vitest'

import { applySlippage } from '../swap/assets'
import { DEFAULT_SLIPPAGE_BPS } from '../swap/build-tx'

/**
 * The slippage floor on a swap inside a plan.
 *
 * A sequence is composed in the browser, and the browser cannot honestly price
 * a trade: any figure it computes comes from a quote taken before the swap
 * runs. The first version of the sequence therefore passed `minReceive: '1'` —
 * one stroop — which is not a conservative floor but the complete absence of
 * one. The network enforces whatever it is given, so that swap would have
 * accepted any fill at all, including a catastrophic one.
 *
 * The convention that replaced it: `'0'` means "price this for me", and the
 * build route re-quotes against live liquidity and applies the same tolerance
 * the ordinary swap path uses. These tests pin the arithmetic that makes the
 * floor meaningful, and the distinction between asking for one and asserting
 * a nominal one.
 */

describe('a floor has to actually protect the trade', () => {
  it('sits below the quote by the tolerance', () => {
    const quoted = '1000000000'
    const floor = applySlippage(quoted, DEFAULT_SLIPPAGE_BPS)

    expect(BigInt(floor)).toBeLessThan(BigInt(quoted))
    // 0.5% of a billion stroops.
    expect(BigInt(quoted) - BigInt(floor)).toBe(BigInt(5_000_000))
  })

  it('is close enough to the quote to be a floor rather than a formality', () => {
    // The bug this guards. A floor of one stroop is not a strict floor — it
    // permits any fill the network can find, which is the opposite of what a
    // minimum received is for.
    const quoted = '1885701225'
    const floor = applySlippage(quoted, DEFAULT_SLIPPAGE_BPS)

    const ratio = Number(BigInt(floor)) / Number(BigInt(quoted))
    expect(ratio).toBeGreaterThan(0.99)
    expect(BigInt(floor)).toBeGreaterThan(BigInt(1))
  })

  it('scales with the trade rather than being fixed', () => {
    const small = applySlippage('1000000', DEFAULT_SLIPPAGE_BPS)
    const large = applySlippage('100000000', DEFAULT_SLIPPAGE_BPS)
    expect(BigInt(large)).toBeGreaterThan(BigInt(small))
  })

  it('never exceeds what was quoted', () => {
    // A floor above the quote could never fill, which is a different failure
    // but just as broken.
    for (const quoted of ['1', '100', '1000000', '999999999999']) {
      expect(BigInt(applySlippage(quoted, DEFAULT_SLIPPAGE_BPS))).toBeLessThanOrEqual(
        BigInt(quoted)
      )
    }
  })

  it('uses a tolerance a person would recognise as tight', () => {
    // 50 basis points. Documented here because a plan step inherits it
    // silently, and a loose default would be invisible at the call site.
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50)
  })
})
