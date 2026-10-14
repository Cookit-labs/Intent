import { describe, expect, it } from 'vitest'

import { isTerminal, normaliseStatus } from '../naira/status'

describe('normaliseStatus, from the provider’s own strings', () => {
  it.each([
    ['initiated', 'waiting'],
    // The worker watching the deposit wallet is before any deposit.
    ['processing: wallet worker on it..', 'waiting'],
    ['Processing: Wallet worker on it..', 'waiting'],
    ['processing: in bank queue', 'processing'],
    ['disbursed', 'paid'],
    ['Settled in treasury', 'paid'],
    ['timeout: no deposit received', 'expired'],
    ['failed', 'failed'],
  ] as const)('%j is %s', (provider, expected) => {
    expect(normaliseStatus(provider)).toBe(expected)
  })

  it('treats an unfamiliar state as processing, never as waiting', () => {
    // Waiting is what allows a payment. Paying into an order that already has
    // its deposit would pay twice, so only the known pre-deposit state counts.
    expect(normaliseStatus('processing: something new')).toBe('processing')
    expect(normaliseStatus('')).toBe('processing')
  })

  it('knows which states cannot change', () => {
    expect(isTerminal('paid')).toBe(true)
    expect(isTerminal('expired')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('waiting')).toBe(false)
    expect(isTerminal('processing')).toBe(false)
  })
})
