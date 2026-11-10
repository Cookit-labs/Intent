import { describe, expect, it } from 'vitest'

import { chainRouteFromReading } from '../chains/parse-sequence'

const read = {
  action: 'swap',
  tokenIn: 'USDC',
  tokenOut: 'AVAX',
  amountUsd: 0,
  amountStated: false,
  amountIsUsd: false,
  amountOf: 'sent' as const,
  followOn: null,
}

describe('a swap read with no amount', () => {
  it('asks how much, in plain words, instead of refusing', () => {
    const route = chainRouteFromReading(read, '', ['swap my usdc to avax'], 'avalanche')
    expect(route).toMatchObject({
      question: 'How much USDC do you want to swap? You can say a number, or "all my USDC".',
    })
  })
})
