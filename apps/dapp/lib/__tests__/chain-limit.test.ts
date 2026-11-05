import { describe, expect, it } from 'vitest'
import { assertRestingPrice, limitOutput, limitPair } from '../chains/limit'
import { limitSaid, parseChainLimit } from '../chains/parse-limit'

describe('limitOutput', () => {
  it('sells at the stated price', () => {
    expect(limitOutput('1', '110', true, 9, 6)).toBe(BigInt('110000000'))
  })
  it('buys at the stated price, rounding so the price is never worse', () => {
    expect(limitOutput('50', '90', false, 6, 9)).toBe(BigInt('555555556'))
  })
  it('keeps precision a float would lose', () => {
    expect(limitOutput('0.1', '0.3', true, 9, 6)).toBe(BigInt('30000'))
  })
})

describe('limitPair', () => {
  it('reads the side from the token given up', () => {
    expect(limitPair('SOL', 'USDC')).toEqual({ base: 'SOL', quote: 'USDC', selling: true })
    expect(limitPair('USDC', 'SOL')).toEqual({ base: 'SOL', quote: 'USDC', selling: false })
  })
  it('has no pair without exactly one stablecoin', () => {
    expect(limitPair('SOL', 'JUP')).toBeUndefined()
    expect(limitPair('USDC', 'USDT')).toBeUndefined()
  })
  it('reads case and chain names', () => {
    expect(limitPair('sol', 'usdt')).toEqual({ base: 'SOL', quote: 'USDT', selling: true })
    expect(limitPair('solana', 'USDC')).toEqual({ base: 'SOL', quote: 'USDC', selling: true })
  })
})

describe('assertRestingPrice', () => {
  it('refuses a sale below the market, which would fill at once at a loss', () => {
    expect(() => assertRestingPrice('90', 100, true, 'SOL')).toThrow(/below/)
  })
  it('refuses a purchase above the market', () => {
    expect(() => assertRestingPrice('110', 100, false, 'SOL')).toThrow(/above/)
  })
  it.each([
    ['1.10', 100, true],
    ['1000', 100, true],
    ['1', 100, false],
  ])('refuses %s against a market of %s as a likely typo', (price, market, selling) => {
    expect(() => assertRestingPrice(price, market, selling, 'SOL')).toThrow(/Nothing was signed/)
  })
  it('takes a price on the right side, within half the market either way', () => {
    expect(() => assertRestingPrice('110', 100, true, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('149', 100, true, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('90', 100, false, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('51', 100, false, 'SOL')).not.toThrow()
  })
  it('refuses a decimal comma', () => {
    expect(() => assertRestingPrice('1,10', 100, true, 'SOL')).toThrow(/Nothing was signed/)
  })
})

describe('parseChainLimit', () => {
  it.each([
    ['sell 1 SOL at $110', { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' }],
    [
      'sell 1 sol for usdt at 110',
      { amount: '1', tokenIn: 'sol', tokenOut: 'usdt', limitPrice: '110' },
    ],
    [
      'limit sell 1 SOL at 110',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' },
    ],
    [
      'swap 1 SOL to USDC at $110',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' },
    ],
    [
      'swap 1 SOL to USDC when it hits 110.50',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110.50' },
    ],
    [
      'swap 50 USDC to SOL at 90',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    [
      'buy SOL with 50 USDC at $90',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    [
      'buy SOL at $90 with 50 USDC',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    ['sell 1 solana at 110', { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' }],
  ])('reads %s', (typed, want) => {
    expect(parseChainLimit(typed)).toEqual({ kind: 'limit', venue: undefined, ...want })
  })

  it.each([
    'sell 1 SOL',
    'swap 1 SOL to USDC',
    'sell 1 SOL at 1,10',
    'sell $5 of SOL at 110',
    'buy 2 SOL at 90',
    'sell 1 SOL at 110 then cash out',
  ])('leaves %s alone', (typed) => {
    expect(parseChainLimit(typed)).toBeNull()
  })
})

describe('limitSaid', () => {
  const asked = {
    kind: 'limit' as const,
    amount: '1',
    tokenIn: 'SOL',
    tokenOut: 'USDC',
    limitPrice: '110',
  }
  it('wants the amount by its token and the price after it, in the persons own words', () => {
    expect(limitSaid(asked, ['sell 1 SOL at $110'])).toBe(true)
    expect(limitSaid(asked, ['sell 1 SOL', 'at 110'])).toBe(true)
  })
  it('refuses a figure they never said', () => {
    expect(limitSaid({ ...asked, limitPrice: '120' }, ['sell 1 SOL at $110'])).toBe(false)
    expect(limitSaid({ ...asked, amount: '2' }, ['sell 1 SOL at $110'])).toBe(false)
  })
  it('refuses price and amount swapped round', () => {
    expect(limitSaid({ ...asked, amount: '110', limitPrice: '1' }, ['sell 1 SOL at $110'])).toBe(
      false
    )
  })
})
