import { describe, expect, it } from 'vitest'

import { fitToHeld } from '../weave/orders'

/** USDC base units, six places. */
const usdc = (display: string): bigint => BigInt(Math.round(Number(display) * 1e6))

describe('fitToHeld', () => {
  it('asks for less when the whole balance is asked, so the deposit with its fee still fits', () => {
    // The order of 2026-11-10: 5.115078 asked, Weave wanted 5.164624, more than was held.
    const fitted = fitToHeld('5.115078', usdc('5.115078'), 6)
    expect(fitted).toBe('5.014782')
    // Weave adds at most 2% on top, which an order past that is refused for anyway.
    expect(Number(fitted) * 1.02).toBeLessThanOrEqual(5.115078)
  })

  it('leaves an amount alone when its deposit already fits', () => {
    expect(fitToHeld('3', usdc('5.115078'), 6)).toBe('3')
    expect(fitToHeld('5', usdc('5.115078'), 6)).toBe('5')
  })

  it('leaves an amount over the balance alone, to be refused as it is now', () => {
    expect(fitToHeld('9', usdc('5.115078'), 6)).toBe('9')
  })

  it('works to each chain’s own places', () => {
    expect(fitToHeld('12.63', BigInt('12630000'), 6)).toBe('12.382352')
    expect(fitToHeld('1', BigInt('10000000'), 7)).toBe('0.9803921')
  })
})
