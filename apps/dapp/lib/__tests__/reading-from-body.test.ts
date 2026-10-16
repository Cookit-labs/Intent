import { describe, expect, it } from 'vitest'

import { readingFromBody } from '../reading-from-body'

const good = {
  tokenIn: 'USDC',
  tokenOut: 'XLM',
  amount: 20,
  amountIsUsd: false,
  amountOf: 'sent',
  style: 'market',
}

describe('readingFromBody', () => {
  it('keeps which asset the quantity counts', () => {
    expect(readingFromBody(good, 'turn 20 USDC into XLM')).toEqual({
      text: 'turn 20 USDC into XLM',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amount: 20,
      amountIsUsd: false,
      amountOf: 'sent',
      style: 'market',
    })
  })

  it('leaves it out when absent or unknown, so the default reading applies', () => {
    expect(readingFromBody({ ...good, amountOf: undefined }, 'x')).not.toHaveProperty('amountOf')
    expect(readingFromBody({ ...good, amountOf: 'both' }, 'x')).not.toHaveProperty('amountOf')
  })

  it('keeps a positive limit price and drops anything else', () => {
    expect(readingFromBody({ ...good, style: 'limit', limitPriceUsd: 0.19 }, 'x')).toMatchObject({
      limitPriceUsd: 0.19,
    })
    expect(readingFromBody({ ...good, limitPriceUsd: -1 }, 'x')).not.toHaveProperty('limitPriceUsd')
  })

  it('refuses a body that is not a usable reading', () => {
    expect(readingFromBody(null, 'x')).toBeUndefined()
    expect(readingFromBody({ ...good, amount: 0 }, 'x')).toBeUndefined()
    expect(readingFromBody({ ...good, tokenIn: 5 }, 'x')).toBeUndefined()
    expect(readingFromBody({ ...good, style: 'yolo' }, 'x')).toBeUndefined()
  })
})
