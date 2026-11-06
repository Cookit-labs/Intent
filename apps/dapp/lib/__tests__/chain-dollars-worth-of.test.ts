import { describe, expect, it } from 'vitest'

import { dollarsWorthOf } from '../chains/parse-action'
import { readChainMessage } from '../chains/parse-sequence'
import { parseCashout, routeCashout } from '../weave/parse-cashout'

const read = (text: string) => readChainMessage(text, 'solana', 'Solana')

describe('"$X worth of TOKEN" read as dollars, before any model sees it', () => {
  it('reads a swap into naira as dollars of SOL cashed out', () => {
    for (const text of [
      'swap $0.8 worth of sol to naira',
      'swap $0.8 of sol to naira',
      'convert 0.8 dollars worth of sol to naira',
    ]) {
      expect(read(text), text).toMatchObject({
        kind: 'cashout',
        route: { kind: 'sequence', token: 'SOL', amount: '0.8', amountIsUsd: true },
      })
    }
  })

  it('reads an offramp as dollars of SOL, never 0.8 SOL', () => {
    for (const text of [
      'offramp $0.8 worth of sol to naira',
      'cash out $0.8 of sol to naira',
      'offramp 0.8 dollars worth of sol to naira',
      'cash out $0.8 worth of my sol to naira',
    ]) {
      const route = routeCashout(parseCashout(text), 'solana', true)
      expect(route, text).toMatchObject({
        kind: 'sequence',
        token: 'SOL',
        amount: '0.8',
        amountIsUsd: true,
      })
    }
  })

  it('reads a swap to a token, and one with a follow-on, as dollars', () => {
    expect(read('swap $5 worth of sol to usdc')).toMatchObject({
      kind: 'action',
      action: { kind: 'swap', amount: '5', amountIsUsd: true },
    })
    expect(read('swap $5 of sol to usdc then cash out')).toMatchObject({
      kind: 'sequence',
      request: { swap: { amount: '5', amountIsUsd: true } },
    })
  })

  it('leaves a count of the token as a count', () => {
    expect(read('swap 0.8 sol to usdc')).toMatchObject({
      kind: 'action',
      action: { amount: '0.8' },
    })
    expect(read('swap 0.8 sol to usdc')).not.toMatchObject({ action: { amountIsUsd: true } })
    expect(routeCashout(parseCashout('offramp 0.8 sol to naira'), 'solana', true)).toMatchObject({
      kind: 'sequence',
      amount: '0.8',
    })
  })

  it('keeps a dollar of USDC as one USDC', () => {
    expect(read('swap $5 worth of usdc to sol')).toMatchObject({
      kind: 'action',
      action: { amount: '5', tokenIn: 'usdc' },
    })
    expect(read('swap $5 worth of usdc to sol')).not.toMatchObject({
      action: { amountIsUsd: true },
    })
  })

  it('rewrites only a figure followed by "worth of" or "of" and a word', () => {
    expect(dollarsWorthOf('swap $0.8 worth of sol to naira')).toBe('swap $0.8 sol to naira')
    expect(dollarsWorthOf('cash out 5 usd worth of my sol')).toBe('cash out $5 sol')
    expect(dollarsWorthOf('swap 5 sol to usdc')).toBe('swap 5 sol to usdc')
    expect(dollarsWorthOf('swap 5 of my sol to usdc')).toBe('swap 5 of my sol to usdc')
    expect(dollarsWorthOf('sell 1 sol if it hits $110 of profit')).toBe(
      'sell 1 sol if it hits $110 of profit'
    )
  })
})
