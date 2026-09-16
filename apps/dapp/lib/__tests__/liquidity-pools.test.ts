import { describe, expect, it } from 'vitest'

import { poolShare, parsePool, type HorizonPool } from '../swap/liquidity-pools'

/**
 * Reading Stellar's built-in liquidity pools.
 *
 * A pool is a yield primitive that needs no protocol integration: deposit both
 * sides, earn a share of the 30bp fee on every trade routed through it,
 * withdraw whenever. The network runs it, so there is no contract to trust and
 * nothing that can be shut down.
 *
 * What makes the reading non-trivial is that a share balance means nothing on
 * its own. Owning 50 of 500 shares is a claim on a tenth of *whatever the pool
 * currently holds*, and that changes with every trade — so a position has to
 * be computed against live reserves rather than stored.
 */

function pool(over: Partial<HorizonPool> = {}): HorizonPool {
  return {
    id: '00281c3bf94d',
    fee_bp: 30,
    total_shares: '50000.0000000',
    total_trustlines: '3',
    reserves: [
      { asset: 'native', amount: '500000.0000000' },
      {
        asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '5000.0000000',
      },
    ],
    ...over,
  }
}

describe('reading a pool', () => {
  it('names both sides in a form the UI can show', () => {
    const parsed = parsePool(pool())
    expect(parsed.assets.map((a) => a.code)).toEqual(['XLM', 'USDC'])
  })

  it('keeps the issuer, so a lookalike is distinguishable', () => {
    // Six testnet pools trade a token called USDC from six different issuers.
    // A pool identified by ticker alone is not identified at all.
    const parsed = parsePool(pool())
    expect(parsed.assets[1]?.issuer).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    )
  })

  it('reports the fee as a percentage people recognise', () => {
    expect(parsePool(pool()).feePct).toBeCloseTo(0.3, 5)
  })

  it('reads the native side as XLM rather than "native"', () => {
    expect(parsePool(pool()).assets[0]?.code).toBe('XLM')
    expect(parsePool(pool()).assets[0]?.issuer).toBeUndefined()
  })

  it('reports the price implied by the reserves', () => {
    // 500,000 XLM against 5,000 USDC is $0.01 per XLM. Derived rather than
    // quoted: this is what the pool would trade at right now.
    expect(parsePool(pool()).impliedPrice).toBeCloseTo(0.01, 6)
  })

  it('survives a pool with an empty side', () => {
    // Observed live: a pool holding 9 XLM and 0 USDC. Dividing by it would
    // produce Infinity and render as a price.
    const empty = parsePool(
      pool({
        reserves: [
          { asset: 'native', amount: '9.0000000' },
          {
            asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            amount: '0.0000000',
          },
        ],
      })
    )
    expect(empty.impliedPrice).toBeUndefined()
    expect(empty.isEmpty).toBe(true)
  })
})

describe('what a share balance is actually worth', () => {
  it('computes a claim on both reserves', () => {
    // 5,000 of 50,000 shares is a tenth of the pool.
    const share = poolShare(parsePool(pool()), '5000')
    expect(Number(share.amounts[0]?.amount)).toBeCloseTo(50000, 2)
    expect(Number(share.amounts[1]?.amount)).toBeCloseTo(500, 2)
    expect(share.sharePct).toBeCloseTo(10, 5)
  })

  it('reports nothing for an account holding no shares', () => {
    const share = poolShare(parsePool(pool()), '0')
    expect(share.sharePct).toBe(0)
    expect(Number(share.amounts[0]?.amount)).toBe(0)
  })

  it('does not divide by zero on an unshared pool', () => {
    // A pool can exist with no shares outstanding after everyone withdraws.
    const share = poolShare(parsePool(pool({ total_shares: '0' })), '0')
    expect(share.sharePct).toBe(0)
  })

  it('values a position against current reserves, not deposit-time ones', () => {
    // The point of computing rather than storing: the same shares are worth
    // less XLM after the pool trades against it.
    const before = poolShare(parsePool(pool()), '5000')
    const after = poolShare(
      parsePool(
        pool({
          reserves: [
            { asset: 'native', amount: '250000.0000000' },
            {
              asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              amount: '10000.0000000',
            },
          ],
        })
      ),
      '5000'
    )
    expect(Number(after.amounts[0]?.amount)).toBeLessThan(Number(before.amounts[0]?.amount))
    expect(Number(after.amounts[1]?.amount)).toBeGreaterThan(Number(before.amounts[1]?.amount))
  })
})
