import { describe, expect, it } from 'vitest'

import { measureRoute } from '../agents/measure'

/**
 * What a route is worth, from its real numbers and the oracle.
 *
 * Figures from the live testnet on 2026-09-17: for 20 USDC Soroswap delivered
 * 187.6348 XLM, Horizon 102.592 XLM, Aquarius 43.1388 XLM; Reflector priced
 * XLM at $0.1798. The point of measuring is that these three routes are then
 * ranked by what they deliver, not by what an agent said about them.
 */

const PRICES = { USDC: 1, XLM: 0.1798 }
const USDC = { code: 'USDC' }
const XLM = { code: 'XLM' }

describe('measuring a route against the oracle', () => {
  it('prices a unit received from what was sent', () => {
    // 20 USDC for 187.6348 XLM: $20 / 187.6348 = $0.1066 per XLM.
    const m = measureRoute(
      { sendAmount: '200000000', destAmount: '1876348104', from: USDC, to: XLM },
      PRICES
    )
    expect(m?.avgPriceUsd).toBeCloseTo(0.1066, 4)
  })

  it('reports a fill above fair value as better than the oracle', () => {
    // 187.63 XLM at $0.1798 is $33.74 for $20 sent: 68.7% better than fair.
    const m = measureRoute(
      { sendAmount: '200000000', destAmount: '1876348104', from: USDC, to: XLM },
      PRICES
    )
    expect(m?.efficiency).toBeCloseTo(1.687, 3)
    expect(m?.vsOraclePct).toBeCloseTo(-68.7, 1)
  })

  it('reports a fill below fair value as worse than the oracle', () => {
    // 43.1388 XLM at $0.1798 is $7.76 for $20 sent: 61.2% worse than fair.
    const m = measureRoute(
      { sendAmount: '200000000', destAmount: '431388000', from: USDC, to: XLM },
      PRICES
    )
    expect(m?.vsOraclePct).toBeCloseTo(61.2, 1)
  })

  it('ranks the three live routes by what they deliver', () => {
    const soroswap = measureRoute(
      { sendAmount: '200000000', destAmount: '1876348104', from: USDC, to: XLM },
      PRICES
    )
    const horizon = measureRoute(
      { sendAmount: '200000000', destAmount: '1025920000', from: USDC, to: XLM },
      PRICES
    )
    const aquarius = measureRoute(
      { sendAmount: '200000000', destAmount: '431388000', from: USDC, to: XLM },
      PRICES
    )
    expect(soroswap?.efficiency).toBeGreaterThan(horizon?.efficiency ?? 0)
    expect(horizon?.efficiency).toBeGreaterThan(aquarius?.efficiency ?? 0)
  })

  it('is direction-agnostic', () => {
    // Selling 100 XLM for 61.4429 USDC: $17.98 in, $61.44 out.
    const m = measureRoute(
      { sendAmount: '1000000000', destAmount: '614429000', from: XLM, to: USDC },
      PRICES
    )
    expect(m?.efficiency).toBeCloseTo(3.417, 3)
  })

  it('is undefined when an asset has no price', () => {
    // An unpriced asset is not a free one. Treating it as zero would make
    // any route through it look infinitely efficient.
    const m = measureRoute(
      { sendAmount: '200000000', destAmount: '1000000', from: USDC, to: { code: 'CETES' } },
      PRICES
    )
    expect(m).toBeUndefined()
  })

  it('is undefined on a zero or malformed amount', () => {
    expect(
      measureRoute({ sendAmount: '0', destAmount: '1', from: USDC, to: XLM }, PRICES)
    ).toBeUndefined()
    expect(
      measureRoute({ sendAmount: '1', destAmount: '0', from: USDC, to: XLM }, PRICES)
    ).toBeUndefined()
  })
})
