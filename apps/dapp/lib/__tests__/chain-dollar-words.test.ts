import { describe, expect, it } from 'vitest'

import { unitsForDollars } from '../chains/dollar-amount'
import { requestSaid } from '../chains/parse-sequence'
import { cashoutSaid, dollarsSaid, sequenceWordsMatch } from '../chains/sequence-flow'

const count = (amount: string) => ({ amount, token: 'SOL' })
const swap = (amount: string, amountIsUsd = false) => ({
  kind: 'swap' as const,
  amount,
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  venue: undefined,
  ...(amountIsUsd ? { amountIsUsd: true as const } : {}),
})

describe('when dollars and a count are both in what was said', () => {
  it('does not turn a correction of dollars into that many tokens', () => {
    const said = ['swap $1 of sol to usdc, no make it 2']
    expect(sequenceWordsMatch(count('2'), said)).toBe(false)
    expect(requestSaid(swap('2'), said)).toBe(false)
    expect(requestSaid(swap('2'), ['swap $1 of sol to usdc', 'no make it 2'])).toBe(false)
  })

  it('still takes a correction that names the token', () => {
    expect(requestSaid(swap('2'), ['swap $1 of sol to usdc', 'make it 2 sol'])).toBe(true)
  })

  it.each([
    ['swap 5 sol to usdc if the price is above $100', '5', '100'],
    ['cash out 2 sol, about $300.', '2', '300'],
  ])('lets the model choose neither in: %s', (typed, tokens, dollars) => {
    expect(sequenceWordsMatch(count(tokens), [typed])).toBe(false)
    expect(dollarsSaid(dollars, 'SOL', undefined, [typed])).toBe(false)
  })

  it('refuses both readings of a count then a correction in dollars', () => {
    const said = ['swap 2 sol to usdc', 'actually $5']
    expect(requestSaid(swap('2'), said)).toBe(false)
    expect(requestSaid(swap('5', true), said)).toBe(false)
  })

  it('reads a figure held in dollars apart from a count spent', () => {
    const said = ['I have $100 of sol, swap 2 sol to usdc']
    expect(requestSaid(swap('2'), said)).toBe(true)
    expect(requestSaid(swap('100', true), said)).toBe(false)
  })

  it('applies to a cash-out the model wrote out', () => {
    const route = { kind: 'sequence' as const, token: 'SOL', amount: '2' }
    expect(cashoutSaid(route, ['cash out 2 sol, about $300.'])).toBe(false)
    expect(
      cashoutSaid({ ...route, amount: '300', amountIsUsd: true }, ['cash out 2 sol, about $300.'])
    ).toBe(false)
    expect(cashoutSaid({ ...route, amount: '5', amountIsUsd: true }, ['cash out $5 of sol'])).toBe(
      true
    )
  })
})

describe('a bare dollar figure', () => {
  it('counts as a correction of dollars, in its own turn or after a word that says so', () => {
    expect(dollarsSaid('1', 'SOL', undefined, ['swap $5 of sol', '$1'])).toBe(true)
    expect(dollarsSaid('1', 'SOL', undefined, ['swap $5 of sol', 'actually $1'])).toBe(true)
    expect(dollarsSaid('1', 'SOL', undefined, ['swap $5 of sol, no make it $1'])).toBe(true)
  })

  it('does not count when it is a condition on the swap', () => {
    const said = ['swap $5 of sol to usdc if the price is above $100']
    expect(dollarsSaid('100', 'SOL', 'USDC', said)).toBe(false)
    expect(dollarsSaid('5', 'SOL', 'USDC', said)).toBe(false)
  })

  it('still reads over a question answered in between', () => {
    const said = ['offramp $1 worth of solana', 'naira']
    expect(dollarsSaid('1', 'SOL', undefined, said)).toBe(true)
  })
})

describe('other dollars', () => {
  it.each(['cash out R$100 of sol', 'cash out A$100 of sol', 'cash out CA$100 of sol'])(
    'does not read %s as US dollars',
    (typed) => {
      expect(dollarsSaid('100', 'SOL', undefined, [typed])).toBe(false)
    }
  )

  it('reads US$ as dollars', () => {
    expect(dollarsSaid('100', 'SOL', undefined, ['cash out US$100 of sol'])).toBe(true)
  })
})

describe('unitsForDollars with a sum too big to write out', () => {
  it('gives nothing, rather than a figure in exponent form', () => {
    expect(unitsForDollars('1'.repeat(31), 96.66, 9)).toBeUndefined()
  })
})
