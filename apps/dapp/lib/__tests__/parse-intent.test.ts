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
    // Names a price, so it is a limit buy described as accumulation rather
    // than an open-ended one. See the price-decides-type cases below.
    ['Accumulate 2 ETH below $3,200', 'limit_buy'],
    ['Accumulate 2 ETH over the next month', 'accumulate'],
    ['Hedge 15,000 USDC exposure', 'hedge'],
  ])('reads %j as %s', (text, expected) => {
    expect(parseIntent(text, PRICES).input.type).toBe(expected)
  })
})

/**
 * A dollar budget must survive parsing unchanged.
 *
 * "Buy $200 worth of XLM" was escrowing $37. The non-swap branch multiplied a
 * figure that was already in dollars by the token price, so the order shrank by
 * whatever XLM happened to cost — and moved with the market, meaning the same
 * sentence meant something different every hour. Buy-side intents never carry a
 * swap keyword, so this path took every one of them.
 */
describe('budget intents keep their stated size', () => {
  const live = { XLM: 0.1838, USDC: 1, USDT: 1, WETH: 3500 }

  it('escrows the stated dollar amount, not a price-scaled one', () => {
    expect(parseIntent('Buy $200 worth of XLM', live).escrowUsd).toBe(200)
  })

  it('holds regardless of what the token costs', () => {
    // The defect's signature: the size tracked the price.
    const cheap = parseIntent('Buy $200 worth of XLM', { ...live, XLM: 0.05 })
    const dear = parseIntent('Buy $200 worth of XLM', { ...live, XLM: 4.2 })
    expect(cheap.escrowUsd).toBe(200)
    expect(dear.escrowUsd).toBe(200)
  })

  it('reads an accumulate intent with splits and a price cap', () => {
    const p = parseIntent('Accumulate $200 worth of XLM below a $0.19 price across 6 splits', live)
    expect(p.escrowUsd).toBe(200)
    // The cap, not the budget. Taking the first dollar figure read this as a
    // $200 limit price.
    expect(p.targetPriceUsd).toBeCloseTo(0.19, 5)
  })

  it('reads a price cap written with an article', () => {
    // "below a $0.19 price" — the article used to break the match entirely.
    expect(parseIntent('Buy $200 of XLM below a $0.19 price', live).targetPriceUsd).toBeCloseTo(
      0.19,
      5
    )
  })

  it('still treats a bare quantity as a token count', () => {
    // "Buy 200 XLM" is 200 XLM, roughly $37 — the one case where scaling by
    // price is correct.
    expect(parseIntent('Buy 200 XLM', live).escrowUsd).toBe(37)
  })

  it('does not mistake a limit price for a budget', () => {
    const p = parseIntent('Sell 100 XLM at $0.25 or better', live)
    expect(p.input.amountIn).toBe('100')
    expect(p.targetPriceUsd).toBeCloseTo(0.25, 5)
  })

  it('leaves swap sizing unchanged', () => {
    const p = parseIntent('Swap $30 worth of XLM to USDC', live)
    expect(p.escrowUsd).toBe(30)
    expect(Number(p.input.amountIn)).toBeCloseTo(30 / 0.1838, 2)
  })
})

/**
 * A stated price makes an intent a limit order, whatever else the text says.
 *
 * "Accumulate $200 of XLM below $0.19" matched the word "accumulate" first and
 * was classified as an open-ended TWAP, dropping the one instruction that
 * mattered — the price the user would not trade through.
 */
describe('a named price decides the intent type', () => {
  const live = { XLM: 0.1838, USDC: 1, USDT: 1 }

  it('reads accumulate with a price cap as a limit buy', () => {
    const p = parseIntent('Accumulate $200 worth of XLM below a $0.19 price', live)
    expect(p.input.type).toBe('limit_buy')
    expect(p.targetPriceUsd).toBeCloseTo(0.19, 5)
  })

  it('keeps an open-ended accumulate as accumulate', () => {
    // No price named, so there is nothing to hold out for.
    expect(parseIntent('Accumulate $200 worth of XLM over the next week', live).input.type).toBe(
      'accumulate'
    )
  })

  it('still reads DCA without a price as accumulate', () => {
    expect(parseIntent('DCA into XLM weekly', live).input.type).toBe('accumulate')
  })

  it('reads a sell with a price as a limit sell', () => {
    expect(parseIntent('Sell 100 XLM at $0.25 or better', live).input.type).toBe('limit_sell')
  })

  it('leaves a plain swap as a market buy', () => {
    expect(parseIntent('Swap $30 worth of XLM to USDC', live).input.type).toBe('market_buy')
  })
})
