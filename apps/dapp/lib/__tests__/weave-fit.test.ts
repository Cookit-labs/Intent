import { describe, expect, it } from 'vitest'

import { fitToHeld } from '../weave/orders'

/** USDC base units, six places. */
const usdc = (display: string): bigint => BigInt(Math.round(Number(display) * 1e6))

/** Weave's real orders: what was asked, and the deposit it answered with. */
const REAL_ORDERS: readonly [asked: number, deposit: number][] = [
  [5, 5.053499], // NEAR, 2026-11-12
  [5.115078, 5.164624], // Avalanche, 2026-11-10
  [0.88, 0.891457], // NEAR, 2026-11-12, order caf16c20
]

describe('fitToHeld', () => {
  it('leaves room for every fee Weave has really added', () => {
    for (const [asked, deposit] of REAL_ORDERS) {
      const fitted = Number(fitToHeld(String(deposit), usdc(String(deposit)), 6))
      // Asked for exactly what that deposit was, the fitted amount's deposit still fits.
      expect(fitted * (deposit / asked)).toBeLessThanOrEqual(deposit)
    }
  })

  it('sends nearly all of a swap that is cashed out whole: the order of 2026-11-12', () => {
    // 0.900614 USDC arrived from the swap. The app asked for 0.88, and 0.009157 stayed behind.
    const held = '0.900614'
    const fitted = Number(fitToHeld(held, usdc(held), 6))
    const deposit = fitted * (0.891457 / 0.88)
    expect(deposit).toBeLessThanOrEqual(Number(held))
    expect(Number(held) - deposit).toBeLessThan(Number(held) * 0.005)
  })

  it('asks for less when the whole balance is asked, so the deposit with its fee still fits', () => {
    // The order of 2026-11-10: 5.115078 asked, Weave wanted 5.164624, more than was held.
    const fitted = fitToHeld('5.115078', usdc('5.115078'), 6)
    expect(fitted).toBe('5.054478')
    expect(Number(fitted) * (5.164624 / 5.115078)).toBeLessThanOrEqual(5.115078)
  })

  it('leaves an amount alone when its deposit already fits', () => {
    expect(fitToHeld('3', usdc('5.115078'), 6)).toBe('3')
    expect(fitToHeld('5', usdc('5.115078'), 6)).toBe('5')
  })

  it('leaves an amount over the balance alone, to be refused as it is now', () => {
    expect(fitToHeld('9', usdc('5.115078'), 6)).toBe('9')
  })

  it('works to each chain’s own places', () => {
    expect(fitToHeld('12.63', BigInt('12630000'), 6)).toBe('12.487636')
    expect(fitToHeld('1', BigInt('10000000'), 7)).toBe('0.984174')
  })

  it('leaves a balance too small for the fee as asked, to be refused by its deposit', () => {
    expect(fitToHeld('0.004', usdc('0.004'), 6)).toBe('0.004')
  })
})
