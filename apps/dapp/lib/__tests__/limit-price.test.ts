import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { offerPriceFromUsd, toPriceFraction, wouldCrossSpread } from '../swap/limit-price'

/**
 * Turning a USD target into an offer price.
 *
 * The app reads USD from *mainnet* because testnet liquidity is synthetic, and
 * executes on *testnet*, where the same asset trades at a different number.
 * Measured while writing this: mainnet XLM near $0.19, the testnet book near
 * 0.11 USDC/XLM.
 *
 * A Stellar offer is priced as a ratio between two assets, fixed when placed.
 * Translating "$0.35" straight into 0.35 USDC/XLM would sit far through the
 * testnet ask and fill on contact — a market order wearing a limit order's
 * label, which is the exact complaint this whole feature exists to answer.
 */

describe('price fractions', () => {
  it('expresses a decimal price as an exact fraction', () => {
    // Stellar takes a rational, not a float, so the price is exact on the
    // ledger rather than the nearest double.
    expect(toPriceFraction('0.25')).toEqual({ n: 1, d: 4 })
  })

  it('reduces to lowest terms', () => {
    expect(toPriceFraction('0.50')).toEqual({ n: 1, d: 2 })
  })

  it('handles a price above one', () => {
    expect(toPriceFraction('2.5')).toEqual({ n: 5, d: 2 })
  })

  it('keeps seven decimal places without drifting', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and a price is money.
    expect(toPriceFraction('0.1234567')).toEqual({ n: 1234567, d: 10_000_000 })
  })

  it('refuses a zero or negative price', () => {
    expect(() => toPriceFraction('0')).toThrow(/positive/)
    expect(() => toPriceFraction('-1')).toThrow(/positive/)
  })

  it('refuses more precision than the ledger keeps', () => {
    expect(() => toPriceFraction('0.12345678')).toThrow(/decimal places/)
  })
})

describe('crossing the spread', () => {
  // Real figures from the testnet XLM/USDC book.
  const book = { bid: 0.108, ask: 0.12 }

  it('knows a sell priced under the bid fills at once', () => {
    // Offering to sell XLM at 0.05 when buyers are bidding 0.108 is a gift.
    expect(wouldCrossSpread({ selling: XLM, price: 0.05, book })).toBe(true)
  })

  it('lets a sell above the bid rest', () => {
    expect(wouldCrossSpread({ selling: XLM, price: 0.15, book })).toBe(false)
  })

  it('knows a buy priced over the ask fills at once', () => {
    // Buying XLM means selling USDC. Willing to pay 0.35 when it is offered at
    // 0.12 crosses immediately.
    expect(wouldCrossSpread({ selling: USDC, price: 0.35, book })).toBe(true)
  })

  it('lets a buy below the ask rest', () => {
    expect(wouldCrossSpread({ selling: USDC, price: 0.09, book })).toBe(false)
  })

  it('treats touching the price as crossing', () => {
    // Equal prices match on Stellar. Calling this "resting" would promise a
    // wait that does not happen.
    expect(wouldCrossSpread({ selling: XLM, price: 0.108, book })).toBe(true)
  })
})

describe('a USD target becomes an offer price', () => {
  const book = { bid: 0.108, ask: 0.12 }

  it('refuses a target that would fill immediately', () => {
    // "Buy XLM below $0.35" against a 0.12 ask. The whole point of the guard.
    const result = offerPriceFromUsd({
      limitPriceUsd: 0.35,
      selling: USDC,
      buying: XLM,
      book,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('would_fill_now')
  })

  it('accepts a target that genuinely rests', () => {
    const result = offerPriceFromUsd({
      limitPriceUsd: 0.09,
      selling: USDC,
      buying: XLM,
      book,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.price).toEqual({ n: 9, d: 100 })
      // Both numbers travel with the decision so the UI can show the gap
      // rather than quietly picking one.
      expect(result.marketPriceUsd).toBe(0.12)
    }
  })

  it('reports the sell side against the bid', () => {
    const result = offerPriceFromUsd({
      limitPriceUsd: 0.42,
      selling: XLM,
      buying: USDC,
      book,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.marketPriceUsd).toBe(0.108)
  })

  it('refuses when the book is empty', () => {
    // No counterparty means no reference price, so there is nothing to check
    // the target against. Placing blind could rest anywhere.
    const result = offerPriceFromUsd({
      limitPriceUsd: 0.09,
      selling: USDC,
      buying: XLM,
      book: { bid: undefined, ask: undefined },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_market')
  })
})
