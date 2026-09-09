import { describe, expect, it } from 'vitest'

import { parseIntent } from '../parse-intent'

/**
 * Sizing and direction. Both have been wrong in ways that cost real money:
 * "$30 of XLM" once sent a third of that, and "sell 100 XLM" once traded in
 * the opposite direction.
 */
const PRICES = { XLM: 0.19, USDC: 1 }

describe('swap direction', () => {
  it('sends the token named first', () => {
    const p = parseIntent('Swap 30 XLM to USDC', PRICES)
    expect(p.input.tokenIn).toBe('XLM')
    expect(p.input.tokenOut).toBe('USDC')
  })

  it('reads a one-sided sell as leaving that asset', () => {
    // Only one token is named, but "sell" fixes the direction.
    const p = parseIntent('Sell 100 XLM at $0.25 or better', PRICES)
    expect(p.input.tokenIn).toBe('XLM')
    expect(p.input.tokenOut).toBe('USDC')
  })
})

describe('sizing', () => {
  it('treats a dollar budget as a budget, not a quantity', () => {
    // $30 at $0.19 is ~158 XLM. Reading 30 as a token count spends a fifth of
    // what was asked for.
    const p = parseIntent('Swap $30 worth of XLM to USDC', PRICES)
    expect(Number(p.input.amountIn)).toBeCloseTo(30 / 0.19, 1)
    expect(p.escrowUsd).toBe(30)
  })

  it('treats a bare number as a token quantity', () => {
    const p = parseIntent('Swap 30 XLM to USDC', PRICES)
    expect(Number(p.input.amountIn)).toBe(30)
  })

  it('does not mistake a limit price for the order size', () => {
    // "sell 100 XLM at $0.25" holds two numbers; the size is the one next to
    // the token.
    const p = parseIntent('Sell 100 XLM at $0.25 or better', PRICES)
    expect(Number(p.input.amountIn)).toBe(100)
    expect(p.targetPriceUsd).toBe(0.25)
  })

  it('is not fooled by "or better" following the price', () => {
    // "or" begins with a letter, which a naive budget check reads as a token.
    const p = parseIntent('Sell 50 XLM at $0.30 or better', PRICES)
    expect(Number(p.input.amountIn)).toBe(50)
  })

  it('uses live prices over the built-in table', () => {
    const cheap = parseIntent('Swap $30 worth of XLM to USDC', { XLM: 0.1, USDC: 1 })
    const dear = parseIntent('Swap $30 worth of XLM to USDC', { XLM: 1, USDC: 1 })
    expect(Number(cheap.input.amountIn)).toBeGreaterThan(Number(dear.input.amountIn))
  })
})

describe('order type', () => {
  it.each([
    ['Sell 100 XLM at $0.25 or better', 'limit_sell'],
    ['Swap 30 XLM to USDC', 'market_buy'],
    ['Accumulate 2 ETH below $3,200', 'accumulate'],
    ['Hedge 15,000 USDC exposure', 'hedge'],
  ])('reads %j as %s', (text, expected) => {
    expect(parseIntent(text, PRICES).input.type).toBe(expected)
  })
})
