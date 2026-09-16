import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { builderFor, type VenueKind } from '../swap/venue-routing'

/**
 * Choosing which builder signs a quote.
 *
 * Three builders now exist and they are not interchangeable. A path payment
 * asserts its destination equals its source; an offer asserts a lone offer
 * operation; a router call asserts the recipient argument. Sending a quote to
 * the wrong one either throws — the good case — or, worse, would build a
 * transaction whose guarantee does not match the shape being signed.
 *
 * So the venue on the quote decides, and it decides in one place rather than
 * at each call site. The build endpoint previously hardcoded Horizon, which
 * meant a Soroswap route could never be signed however good its price.
 */

const horizonQuote = {
  source: 'horizon' as const,
  kind: 'strict_send' as const,
  from: USDC,
  to: XLM,
  sendAmount: '500000000',
  destAmount: '1279739438',
  path: [],
  quotedAt: new Date().toISOString(),
}

const soroswapQuote = { ...horizonQuote, source: 'soroswap' as const, destAmount: '4737844000' }

describe('the venue on the quote picks the builder', () => {
  it('sends a Horizon route to the classic path-payment builder', () => {
    expect(builderFor(horizonQuote)).toBe<VenueKind>('classic')
  })

  it('sends a Soroswap route to the Soroban builder', () => {
    // The whole point of the phase: this route quotes 473 XLM against
    // Horizon's 128 for the same assets, and was unreachable.
    expect(builderFor(soroswapQuote)).toBe<VenueKind>('soroban')
  })

  it('refuses a venue it has no builder for', () => {
    // Guessing would sign the wrong transaction shape. A new source must add a
    // builder before it can be executed, not inherit one by accident.
    expect(() =>
      builderFor({ ...horizonQuote, source: 'uniswap' as unknown as 'horizon' })
    ).toThrow(/no builder/)
  })

  it('refuses a route that settles in a different asset than it names', () => {
    // A Soroban route through a non-canonical contract delivers a token that
    // merely shares a ticker. The builder must never be reached: the user
    // would receive something they did not choose.
    expect(() =>
      builderFor({
        ...soroswapQuote,
        deliversAsset: { kind: 'contract', code: 'USDC', contract: 'CB3TLW74' },
      })
    ).toThrow(/different asset/)
  })
})
