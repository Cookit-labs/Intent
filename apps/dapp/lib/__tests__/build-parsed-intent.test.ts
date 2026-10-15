import { describe, expect, it } from 'vitest'

import { buildParsedIntent } from '../parse-intent'

const prices = { XLM: 0.2, USDC: 1 }

describe('buildParsedIntent', () => {
  it('sizes a dollar budget for a buy', () => {
    const parsed = buildParsedIntent(
      {
        text: 'get me $30 of lumens',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amount: 30,
        amountIsUsd: true,
        style: 'market',
      },
      prices
    )
    expect(parsed.input.type).toBe('market_buy')
    expect(parsed.escrowUsd).toBe(30)
    expect(parsed.input.amountIn).toBe('30')
    expect(parsed.input.minAmountOut).toBe('150.0000')
    expect(parsed.outcome).toBe('get me $30 of lumens')
  })

  it('reads a sale into a stablecoin as a sell', () => {
    const parsed = buildParsedIntent(
      {
        text: 'x',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amount: 30,
        amountIsUsd: true,
        style: 'market',
      },
      prices
    )
    expect(parsed.input.type).toBe('market_sell')
    expect(parsed.input.amountIn).toBe('150')
  })

  it('treats a bare quantity bought with a stablecoin as a quantity of the asset arriving', () => {
    const parsed = buildParsedIntent(
      {
        text: 'x',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amount: 300,
        amountIsUsd: false,
        style: 'market',
      },
      prices
    )
    expect(parsed.escrowUsd).toBe(60)
    expect(parsed.input.amountIn).toBe('60')
  })

  it('treats a bare quantity of the asset sold as the amount sent', () => {
    const parsed = buildParsedIntent(
      {
        text: 'x',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amount: 100,
        amountIsUsd: false,
        style: 'market',
      },
      prices
    )
    expect(parsed.escrowUsd).toBe(20)
    expect(parsed.input.amountIn).toBe('100')
  })

  it('keeps the price the user named apart from the fallback', () => {
    const limit = buildParsedIntent(
      {
        text: 'x',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amount: 20,
        amountIsUsd: true,
        style: 'limit',
        limitPriceUsd: 0.19,
      },
      prices
    )
    expect(limit.input.type).toBe('limit_buy')
    expect(limit.limitPriceUsd).toBe(0.19)
    expect(limit.targetPriceUsd).toBe(0.19)

    const market = buildParsedIntent(
      {
        text: 'x',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amount: 20,
        amountIsUsd: true,
        style: 'market',
      },
      prices
    )
    expect(market.limitPriceUsd).toBeUndefined()
    expect(market.targetPriceUsd).toBe(0.2)
  })

  it('keeps the reading on the result so the race can be given the same one', () => {
    const reading = {
      text: 'x',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amount: 30,
      amountIsUsd: true,
      style: 'market' as const,
    }
    expect(buildParsedIntent(reading, prices).reading).toEqual(reading)
  })

  it('maps the other order styles onto intent types', () => {
    const base = { text: 'x', tokenIn: 'USDC', tokenOut: 'XLM', amount: 10, amountIsUsd: true }
    expect(buildParsedIntent({ ...base, style: 'accumulate' }, prices).input.type).toBe(
      'accumulate'
    )
    expect(buildParsedIntent({ ...base, style: 'hedge' }, prices).input.type).toBe('hedge')
    expect(buildParsedIntent({ ...base, style: 'rebalance' }, prices).input.type).toBe('rebalance')
  })
})
