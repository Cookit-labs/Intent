import { describe, expect, it } from 'vitest'

import { isFinal, mapProviderStatus, nextStatus } from '../weave/status'

describe('mapProviderStatus', () => {
  it.each([
    ['awaiting_deposit', 'waiting'],
    ['processing', 'processing'],
    ['completed', 'paid'],
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['refunded', 'refunded'],
    ['  COMPLETED ', 'paid'],
  ])('reads %s as %s', (provider, ours) => {
    expect(mapProviderStatus(provider)).toBe(ours)
  })

  it('does not guess at a string it does not know', () => {
    expect(mapProviderStatus('settling')).toBeUndefined()
    expect(mapProviderStatus('')).toBeUndefined()
  })
})

describe('nextStatus', () => {
  it('moves to what the provider says', () => {
    expect(nextStatus('waiting', 'processing')).toBe('processing')
    expect(nextStatus('processing', 'completed')).toBe('paid')
  })

  it('stays at the current status for an unknown string', () => {
    expect(nextStatus('waiting', 'settling')).toBe('waiting')
    expect(nextStatus('processing', 'settling')).toBe('processing')
  })

  it.each(['paid', 'failed', 'expired', 'refunded'] as const)('never moves %s', (final) => {
    expect(nextStatus(final, 'processing')).toBe(final)
    expect(nextStatus(final, 'awaiting_deposit')).toBe(final)
    expect(nextStatus(final, 'completed')).toBe(final)
  })

  it('never goes back to waiting, which would make a funded order payable again', () => {
    expect(nextStatus('processing', 'awaiting_deposit')).toBe('processing')
  })
})

describe('isFinal', () => {
  it('is true only for states that cannot change', () => {
    expect(isFinal('paid')).toBe(true)
    expect(isFinal('failed')).toBe(true)
    expect(isFinal('expired')).toBe(true)
    expect(isFinal('refunded')).toBe(true)
    expect(isFinal('waiting')).toBe(false)
    expect(isFinal('processing')).toBe(false)
  })
})
