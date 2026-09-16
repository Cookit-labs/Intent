import { describe, expect, it } from 'vitest'

import { parseStandingIntent } from '../parse-standing'

/**
 * Recognising a rule rather than a trade.
 *
 * "Buy XLM" is an instruction to act now. "Buy XLM if it drops to $0.16" is a
 * rule about when to act, and treating the second as the first would execute
 * immediately at a price the user explicitly said they did not want.
 *
 * The conditional word is the whole signal, and it has to be distinguished
 * from a limit price — "buy below $0.16" is a resting order, while "buy if it
 * drops to $0.16" is a rule that produces a market buy when the condition is
 * met. They read alike and mean different things.
 */

describe('conditional rules are recognised', () => {
  it('reads a price-drop condition', () => {
    const rule = parseStandingIntent('Buy $50 of XLM if it drops to $0.16')
    expect(rule?.trigger).toEqual({ kind: 'price_below', asset: 'XLM', priceUsd: 0.16 })
  })

  it('reads a price-rise condition', () => {
    const rule = parseStandingIntent('Sell 100 XLM if it rises to $0.30')
    expect(rule?.trigger).toEqual({ kind: 'price_above', asset: 'XLM', priceUsd: 0.3 })
  })

  it('understands "when" as well as "if"', () => {
    expect(parseStandingIntent('Buy XLM when it hits $0.15')?.trigger.kind).toBe('price_below')
  })

  it('reads a percentage drop against a reference price', () => {
    // "If XLM drops 10%" needs today's price to mean anything, so the caller
    // supplies it rather than the parser inventing one.
    const rule = parseStandingIntent('Buy $50 of XLM if it drops 10%', { XLM: 0.2 })
    expect(rule?.trigger).toEqual({ kind: 'price_below', asset: 'XLM', priceUsd: 0.18 })
  })

  it('cannot read a percentage without a reference price', () => {
    // Better to decline than to guess: a rule armed at the wrong level trades
    // at a price the user never agreed to.
    expect(parseStandingIntent('Buy XLM if it drops 10%')).toBeNull()
  })
})

describe('recurring rules are recognised', () => {
  it('reads a weekly schedule', () => {
    const rule = parseStandingIntent('Every week move 50 USDC into XLM')
    expect(rule?.trigger).toEqual({ kind: 'schedule', everyHours: 168 })
  })

  it('reads a daily schedule', () => {
    expect(parseStandingIntent('Buy $10 of XLM every day')?.trigger).toEqual({
      kind: 'schedule',
      everyHours: 24,
    })
  })

  it('reads "every friday" as weekly', () => {
    expect(parseStandingIntent('Every Friday buy $50 of XLM')?.trigger).toEqual({
      kind: 'schedule',
      everyHours: 168,
    })
  })
})

describe('ordinary intents are left alone', () => {
  it('does not treat a plain swap as a rule', () => {
    expect(parseStandingIntent('Swap 50 USDC to XLM')).toBeNull()
  })

  it('does not treat a limit order as a rule', () => {
    // The distinction that matters most. "Below $0.16" is a resting order the
    // orderbook holds; a rule is something this app watches. Confusing them
    // would replace a real on-chain order with a browser-side promise.
    expect(parseStandingIntent('Buy 300 XLM below $0.30')).toBeNull()
  })

  it('does not treat "at" pricing as a rule', () => {
    expect(parseStandingIntent('Sell 100 XLM at $0.25')).toBeNull()
  })
})

describe('the action is parsed alongside the rule', () => {
  it('carries the assets and amount', () => {
    const rule = parseStandingIntent('Buy $50 of XLM if it drops to $0.16')
    expect(rule?.action.from).toBe('USDC')
    expect(rule?.action.to).toBe('XLM')
    expect(Number(rule?.action.amountIn)).toBeCloseTo(50, 1)
  })

  it('keeps the original wording', () => {
    // Shown back to the user later, when the rule fires and they have to
    // recognise what they set up weeks earlier.
    const text = 'Buy $50 of XLM if it drops to $0.16'
    expect(parseStandingIntent(text)?.text).toBe(text)
  })
})
