import { describe, expect, it } from 'vitest'

import { offrampSizeWarning, withdrawStepLabel } from '../offramp/labels'

/**
 * What the review says before the first signature.
 *
 * The size check against the anchor's limits is the one thing that must be
 * said *before* the swap: an order that will not fit the anchor should be
 * refused while nothing has moved, not discovered after the swap settled.
 */
describe('withdrawStepLabel', () => {
  it('names the anchor and the estimate', () => {
    expect(withdrawStepLabel('testanchor', '6.4')).toBe(
      'Withdraw about 6.4 USDC to your bank through SDF test anchor'
    )
  })
  it('omits the amount when it is not yet known', () => {
    expect(withdrawStepLabel('moneygram')).toBe(
      'Withdraw the USDC received to your bank through MoneyGram Access (testnet)'
    )
  })
})

describe('offrampSizeWarning', () => {
  const limits = { enabled: true, minAmount: 1, maxAmount: 10, feeEnabled: false }
  it('is silent inside the limits', () => {
    expect(offrampSizeWarning('5', limits)).toBeUndefined()
  })
  it('says when the estimate is below the minimum', () => {
    expect(offrampSizeWarning('0.85', limits)).toMatch(/below.*1 USDC/)
  })
  it('says when the estimate is above the maximum', () => {
    expect(offrampSizeWarning('50', limits)).toMatch(/above.*10 USDC/)
  })
  it('is silent with no limits', () => {
    expect(offrampSizeWarning('50', undefined)).toBeUndefined()
  })
  it('says when withdrawals are disabled', () => {
    expect(offrampSizeWarning('5', { ...limits, enabled: false })).toMatch(/not accepting/)
  })
})
