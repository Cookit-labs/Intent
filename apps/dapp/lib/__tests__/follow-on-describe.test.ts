import { describe, expect, it } from 'vitest'

import { describeFollowOn } from '../parse-compound'

/**
 * The sentence on the "did I read this right?" card.
 *
 * The asset is named whenever the caller knows it. "Supply it to Blend" and
 * "supply the XLM to Blend" are the same instruction, but only the second one
 * lets the user check that the app read the right asset out of the sentence —
 * which is the entire purpose of the card.
 */
describe('describeFollowOn', () => {
  it('describes a lend, naming the asset', () => {
    expect(describeFollowOn({ kind: 'lend', venue: 'blend' }, 'XLM')).toBe(
      'then supply the XLM to Blend'
    )
  })
  it('describes an offramp by anchor name, naming the asset', () => {
    expect(describeFollowOn({ kind: 'offramp', venue: 'moneygram' }, 'USDC')).toBe(
      'then withdraw the USDC to your bank through MoneyGram Access (testnet)'
    )
  })
  it('falls back to the id for an unknown anchor', () => {
    expect(describeFollowOn({ kind: 'offramp', venue: 'x' }, 'USDC')).toBe(
      'then withdraw the USDC to your bank through x'
    )
  })
  it('says "it" when the asset is not known', () => {
    expect(describeFollowOn({ kind: 'lend', venue: 'blend' })).toBe('then supply it to Blend')
    expect(describeFollowOn({ kind: 'offramp', venue: 'testanchor' })).toBe(
      'then withdraw it to your bank through SDF test anchor'
    )
  })
})
