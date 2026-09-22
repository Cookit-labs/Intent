import { describe, expect, it } from 'vitest'

import {
  capToLimits,
  estimatedReceiveOf,
  offrampSizeWarning,
  withdrawStepLabel,
} from '../offramp/labels'

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

/**
 * The cap the warning above promises.
 *
 * The text said "only the maximum will be withdrawn" while the code asked the
 * anchor for the whole delivered amount, which the anchor then refused — after
 * the swap had settled.
 */
describe('capToLimits', () => {
  const limits = { enabled: true, minAmount: 1, maxAmount: 10, feeEnabled: false }
  it('leaves an amount inside the limits alone', () => {
    expect(capToLimits('6.4', limits)).toBe('6.4')
  })
  it('caps an amount above the maximum', () => {
    expect(capToLimits('50', limits)).toBe('10')
  })
  it('leaves the amount alone with no limits', () => {
    expect(capToLimits('50', undefined)).toBe('50')
  })
})

/**
 * Reading the estimate off a quote the browser holds opaquely.
 *
 * The field is `destAmount`, in base units — never `receiveAmount`, which
 * belongs to a strict-receive *request* rather than to a quote. Reading the
 * wrong name returned undefined silently, and the size check above simply
 * never ran. These tests exist so that cannot happen again unnoticed.
 */
describe('estimatedReceiveOf', () => {
  it('converts a quote destAmount to display units', () => {
    const quote = {
      destAmount: '64000000',
      sendAmount: '600000000',
      from: { code: 'XLM' },
      to: { code: 'USDC' },
    }
    expect(estimatedReceiveOf(quote)).toBe('6.4000000')
  })
  it('gives nothing for an object without destAmount', () => {
    expect(estimatedReceiveOf({ sendAmount: '600000000' })).toBeUndefined()
  })
  it('gives nothing for no route at all', () => {
    expect(estimatedReceiveOf(undefined)).toBeUndefined()
  })
})
