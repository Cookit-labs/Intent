import { describe, expect, it } from 'vitest'

import { parseIntent } from '../parse-intent'

/**
 * A quantity is not a price.
 *
 * "Buy 300 XLM below $0.30" contains two numbers and they mean opposite
 * things: 300 is how much to buy, $0.30 is the most to pay per unit. The
 * parser looked for a quantity attached to the token being *spent* — USDC on a
 * buy — found none, and fell through to the first dollar figure in the
 * sentence, which is the limit price. A 300-XLM order became a $0.30 one.
 *
 * The same sentence without a limit parsed correctly, which is what made this
 * hard to see: adding the price is what broke the size.
 */

const prices = { XLM: 0.1772, USDC: 1 }

describe('a quantity attached to the bought token', () => {
  it('reads the size, not the limit price', () => {
    const parsed = parseIntent('Buy 300 XLM below $0.30', prices)

    // 300 XLM at the reference price, paid in USDC.
    expect(Number(parsed.input.amountIn)).toBeCloseTo(300 * prices.XLM, 1)
    expect(parsed.limitPriceUsd).toBe(0.3)
  })

  it('parses the same order without a limit identically', () => {
    // This case always worked. It is here so the two cannot drift apart again.
    const withLimit = parseIntent('Buy 300 XLM below $0.30', prices)
    const without = parseIntent('Buy 300 XLM', prices)

    expect(Number(withLimit.input.amountIn)).toBeCloseTo(Number(without.input.amountIn), 1)
  })

  it('still reads a real budget as a budget', () => {
    // "$300 of XLM" is money to spend, not a quantity to buy.
    const parsed = parseIntent('Buy $300 of XLM', prices)
    expect(Number(parsed.input.amountIn)).toBeCloseTo(300, 1)
  })

  it('keeps a budget and a limit apart', () => {
    const parsed = parseIntent('Buy $300 of XLM below $0.25', prices)
    expect(Number(parsed.input.amountIn)).toBeCloseTo(300, 1)
    expect(parsed.limitPriceUsd).toBe(0.25)
  })

  it('reads a sell quantity in the token being sold', () => {
    const parsed = parseIntent('Sell 1000 XLM above $0.42', prices)
    expect(Number(parsed.input.amountIn)).toBeCloseTo(1000, 1)
    expect(parsed.limitPriceUsd).toBe(0.42)
  })

  it('is not fooled by a limit price larger than the quantity', () => {
    // Here the price is the bigger number, so "take the largest" would also
    // be wrong. Only the token it sits next to distinguishes them.
    const parsed = parseIntent('Buy 5 XLM below $30', prices)
    expect(Number(parsed.input.amountIn)).toBeCloseTo(5 * prices.XLM, 1)
    expect(parsed.limitPriceUsd).toBe(30)
  })
})
