import { describe, expect, it } from 'vitest'

import { tradeCapNote } from '../trade-cap-copy'

describe('tradeCapNote', () => {
  it('says what the cap is, in dollars', () => {
    expect(tradeCapNote(50, 'stellar')).toBe('Each trade is capped at $50 on mainnet.')
  })

  it('formats a larger cap with separators', () => {
    expect(tradeCapNote(2500, 'stellar')).toBe('Each trade is capped at $2,500 on mainnet.')
  })

  it('says nothing when there is no cap', () => {
    expect(tradeCapNote(undefined, 'stellar')).toBeUndefined()
  })

  it('says nothing on Arc, where the Stellar cap does not apply', () => {
    expect(tradeCapNote(50, 'arc')).toBeUndefined()
  })
})
