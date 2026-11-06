import { describe, expect, it } from 'vitest'

import { chainRouteFromReading, type ReadSwap } from '../chains/parse-sequence'
import { limitSaid } from '../chains/parse-limit'
import { LIMIT_NOT_HERE } from '../chains/prepare'

const read = (
  over: Partial<ReadSwap & { action: string }> = {}
): ReadSwap & { action: string } => ({
  action: 'swap',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amountUsd: 0,
  amountStated: true,
  followOn: null,
  style: 'limit',
  ...over,
})

const said = ['I want to get rid of 1 sol once it reaches 110']

describe('the model reading a limit order', () => {
  it('runs as a limit when the instruction is the person own words', () => {
    const route = chainRouteFromReading(read(), 'sell 1 SOL at $110', said)
    expect(route).toMatchObject({ action: { kind: 'limit', amount: '1', limitPrice: '110' } })
  })

  it('refuses a price the person did not say', () => {
    const route = chainRouteFromReading(read(), 'sell 1 SOL at $120', said)
    expect(route).toHaveProperty('refusal')
    expect((route as { refusal: string }).refusal).toMatch(/Nothing was signed or sent\.$/)
  })

  it('never turns a limit reading it cannot parse into a market swap', () => {
    const route = chainRouteFromReading(read(), 'swap 1 SOL to USDC', said)
    expect(route).not.toHaveProperty('action')
    expect((route as { refusal: string }).refusal).toContain('sell 1 SOL at $110')
  })

  it('reads a limit before a swap that takes its price for a venue', () => {
    const route = chainRouteFromReading(
      read({ style: 'market', tokenIn: 'USDC', tokenOut: 'SOL' }),
      'swap 50 USDC to SOL at 90',
      ['swap 50 USDC to SOL at 90']
    )
    expect(route).toMatchObject({ action: { kind: 'limit', limitPrice: '90' } })
  })

  it('asks for the spend on a purchase that names only what it gets', () => {
    const route = chainRouteFromReading(read(), 'buy 2 SOL at 90', ['buy 2 SOL at 90'])
    expect((route as { refusal: string }).refusal).toContain(
      'Say how much you will spend, for example "buy SOL with 180 USDC at $90".'
    )
  })

  it('asks for a count when the amount is dollars', () => {
    const route = chainRouteFromReading(read(), 'sell $5 of SOL at $110', [
      'sell $5 of SOL at $110',
    ])
    expect((route as { refusal: string }).refusal).toContain(
      'Say how much SOL, for example "sell 0.05 SOL at $110".'
    )
  })

  it('refuses a limit on a chain without one', () => {
    const route = chainRouteFromReading(
      read({ tokenIn: 'MON' }),
      'sell 1 MON at $5',
      ['sell 1 MON at $5'],
      'monad'
    )
    expect(route).toEqual({ refusal: LIMIT_NOT_HERE.monad })
  })

  it('leaves a plain swap alone', () => {
    const route = chainRouteFromReading(read({ style: 'market' }), 'swap 1 SOL to USDC', [
      'swap 1 SOL to USDC',
    ])
    expect(route).toMatchObject({ action: { kind: 'swap' } })
  })
})

describe('a sale the person did not word as one', () => {
  const sale = {
    kind: 'limit' as const,
    amount: '1',
    tokenIn: 'SOL',
    tokenOut: 'USDC',
    limitPrice: '110',
  }
  it.each([
    'get me 1 sol once it reaches 110',
    'I want 1 SOL when it hits 110',
    'pick up 1 sol at 110',
    'grab 1 sol at $110',
    'sell my usdc to get 1 sol at 110',
    'I want to sell 1 SOL at 110',
  ])('is not taken for "%s"', (words) => {
    expect(limitSaid(sale, [words])).toBe(false)
  })
  it.each(['get rid of 1 sol once it reaches 110', 'sell 1 SOL at $110', 'dump 1 sol at 110'])(
    'is taken for "%s"',
    (words) => {
      expect(limitSaid(sale, [words])).toBe(true)
    }
  )
})
