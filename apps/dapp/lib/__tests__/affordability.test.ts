import { describe, expect, it } from 'vitest'

import { checkAffordability } from '../affordability'
import type { StellarBalances } from '../stellar-account'

/**
 * An order must be checked against the wallet that will pay for it.
 *
 * Nothing checked this: an account holding under $200 opened a $200 limit
 * order, and the app showed it as a live position. The order was never
 * fundable, so the only thing it could ever do is fail — after hours of
 * appearing to work.
 */
const funded: StellarBalances = {
  xlm: '500',
  usdc: '150',
  hasUsdcTrustline: true,
  exists: true,
}

describe('affordability', () => {
  it('refuses an order larger than the USDC balance', () => {
    // The reported case: $200 order against $150 held.
    const out = checkAffordability('200', 'USDC', funded)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('insufficient')
    expect(out.message).toContain('200')
    expect(out.message).toContain('150')
  })

  it('allows an order the account can cover', () => {
    expect(checkAffordability('100', 'USDC', funded).ok).toBe(true)
  })

  it('refuses USDC when no trustline exists', () => {
    // Stellar cannot hold an issued asset without a trustline, so the balance
    // is not merely zero — the account cannot receive it at all.
    const out = checkAffordability('10', 'USDC', {
      ...funded,
      hasUsdcTrustline: false,
      usdc: undefined,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_trustline')
  })

  it('keeps XLM headroom for fees and the reserve', () => {
    // Spending the full balance leaves nothing for the fee, and the network
    // would reject the transaction after this check had approved it.
    const out = checkAffordability('500', 'XLM', funded)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('insufficient')
  })

  it('allows XLM within the spendable balance', () => {
    expect(checkAffordability('400', 'XLM', funded).ok).toBe(true)
  })

  it('refuses an unfunded account', () => {
    const out = checkAffordability('1', 'XLM', {
      xlm: '0',
      usdc: undefined,
      hasUsdcTrustline: false,
      exists: false,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('unfunded')
  })

  it('refuses when no wallet is connected', () => {
    expect(checkAffordability('1', 'USDC', undefined).reason).toBe('not_connected')
  })

  it('refuses an asset whose balance it cannot read', () => {
    // Defaulting to "allowed" here would reintroduce the original bug for
    // every asset the app does not yet track.
    const out = checkAffordability('1', 'WETH', funded)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('unknown_asset')
  })
})
