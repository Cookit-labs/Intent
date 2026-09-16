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
  // The trustline map is the real source of truth now; `usdc` and
  // `hasUsdcTrustline` are the older single-asset view of the same fact and
  // must agree with it.
  trustlines: {
    USDC: { balance: '150', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  },
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
      // Cleared here too: the trustline map is what the check actually reads,
      // and leaving USDC in it while claiming no trustline describes an
      // account that cannot exist.
      trustlines: {},
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
      trustlines: {},
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

/**
 * A resting order costs more than the trade it will make.
 *
 * Stellar raises the account's minimum balance by half a lumen for every open
 * offer. It comes back when the order fills or is withdrawn, so it is not a
 * fee — but it is unspendable while the order waits, and an account with just
 * enough to swap can still be refused when placing one.
 */
describe('an order that rests needs extra headroom', () => {
  const funded = {
    xlm: '3',
    usdc: '100',
    hasUsdcTrustline: true,
    exists: true,
    trustlines: {
      USDC: { balance: '100', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  }

  it('allows a swap that a resting order could not afford', () => {
    // 3 XLM held, 1.5 headroom, so 1.5 spendable as an immediate swap.
    expect(checkAffordability('1.4', 'XLM', funded).ok).toBe(true)
  })

  it('refuses the same amount once it has to rest', () => {
    // The extra 0.5 reserve leaves only 1.0 spendable.
    const resting = checkAffordability('1.4', 'XLM', funded, true)
    expect(resting.ok).toBe(false)
    expect(resting.message).toMatch(/while the order rests/)
  })

  it('still allows a resting order that fits', () => {
    expect(checkAffordability('0.9', 'XLM', funded, true).ok).toBe(true)
  })
})

/**
 * Tokenized treasuries need the same checks as any other issued asset.
 *
 * The check was written around USDC with a field per asset, which stopped
 * scaling the moment a second issued asset became tradeable. Refusing CETES as
 * "unknown" would have been wrong rather than cautious.
 */
describe('real-world assets are checked like any other issued asset', () => {
  const ETHERFUSE = 'GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4'

  const holder: StellarBalances = {
    xlm: '500',
    usdc: '150',
    hasUsdcTrustline: true,
    exists: true,
    trustlines: {
      USDC: { balance: '150', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      CETES: { balance: '2000', issuer: ETHERFUSE },
    },
  }

  it('allows spending a treasury balance the account holds', () => {
    expect(checkAffordability('1000', 'CETES', holder).ok).toBe(true)
  })

  it('refuses more than is held', () => {
    const out = checkAffordability('5000', 'CETES', holder)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('insufficient')
  })

  it('refuses when the account cannot hold the asset at all', () => {
    const out = checkAffordability('10', 'CETES', { ...holder, trustlines: {} })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_trustline')
    expect(out.message).toContain('CETES')
  })

  it('refuses a token that shares the ticker but not the issuer', () => {
    // The attack the asset registry exists to stop, reaching this layer: an
    // account holding some other account's "CETES" cannot spend Etherfuse
    // CETES, and treating the two as the same asset would approve an order
    // that fails on-chain.
    const impostor = {
      ...holder,
      trustlines: {
        CETES: {
          balance: '9999',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
      },
    }
    const out = checkAffordability('10', 'CETES', impostor)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_trustline')
  })
})
