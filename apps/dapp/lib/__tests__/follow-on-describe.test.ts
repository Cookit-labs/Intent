import { describe, expect, it } from 'vitest'

import { describeFollowOn } from '../parse-compound'

/** The sentence on the "did I read this right?" card. */
describe('describeFollowOn', () => {
  it('describes a lend', () => {
    expect(describeFollowOn({ kind: 'lend', venue: 'blend' })).toBe('then supply it to Blend')
  })
  it('describes an offramp by anchor name', () => {
    expect(describeFollowOn({ kind: 'offramp', venue: 'moneygram' })).toBe(
      'then withdraw it to your bank through MoneyGram Access (testnet)'
    )
  })
  it('falls back to the id for an unknown anchor', () => {
    expect(describeFollowOn({ kind: 'offramp', venue: 'x' })).toBe(
      'then withdraw it to your bank through x'
    )
  })
})
