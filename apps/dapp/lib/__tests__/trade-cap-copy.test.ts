import { describe, expect, it } from 'vitest'

import { tradeCapNote } from '../trade-cap-copy'

describe('tradeCapNote', () => {
  it('says what the cap is, in dollars', () => {
    expect(tradeCapNote(50)).toBe('Each trade is capped at $50 on mainnet.')
  })

  it('formats a larger cap with separators', () => {
    expect(tradeCapNote(2500)).toBe('Each trade is capped at $2,500 on mainnet.')
  })

  it('says nothing when there is no cap', () => {
    expect(tradeCapNote(undefined)).toBeUndefined()
  })
})
