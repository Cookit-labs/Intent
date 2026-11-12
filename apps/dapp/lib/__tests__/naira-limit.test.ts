import { describe, expect, it } from 'vitest'

import { largestNaira, maxNgn, nairaLimitMessage } from '../naira/limit'

/** One naira ceiling per payout, the same on every chain: ₦2,000,000 unless NAIRA_MAX_NGN says otherwise. */
describe('the naira limit per payout', () => {
  it('is ₦2,000,000 by default', () => {
    expect(maxNgn({})).toBe(2_000_000)
  })

  it('takes NAIRA_MAX_NGN when it is a positive number, and the default otherwise', () => {
    expect(maxNgn({ NAIRA_MAX_NGN: '5000000' })).toBe(5_000_000)
    expect(maxNgn({ NAIRA_MAX_NGN: 'lots' })).toBe(2_000_000)
    expect(maxNgn({ NAIRA_MAX_NGN: '-1' })).toBe(2_000_000)
  })

  it('judges a payout by the largest estimate there is, since either provider may pay it', () => {
    expect(largestNaira([1_900_000, 2_100_000])).toBe(2_100_000)
    expect(largestNaira([undefined, 1_500_000])).toBe(1_500_000)
    expect(largestNaira([undefined, undefined])).toBeUndefined()
    expect(largestNaira([Number.NaN, 10])).toBe(10)
  })

  it('says the limit in naira, and that nothing moved', () => {
    expect(nairaLimitMessage({})).toBe(
      'One payout is limited to ₦2,000,000. Send less, or split it into more than one payout. Nothing was signed or sent.'
    )
  })
})
