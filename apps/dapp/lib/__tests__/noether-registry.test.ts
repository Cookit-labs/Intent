import { describe, expect, it } from 'vitest'

import { NOETHER_MARKET, NOETHER_ROUTER, labelForCall } from '../swap/contract-registry'

/**
 * How a Noether order reads in review.
 *
 * The registry labels by contract and function so a signature over an
 * `invokeHostFunction` is never narrated generically. The ids here are the
 * ones the gateway listed on 2026-09-23; the perp flow itself validates
 * against the ids it resolves at runtime, and these constants only decide the
 * wording.
 */
describe('Noether in the contract registry', () => {
  it('labels an isolated open on the market', () => {
    expect(labelForCall(NOETHER_MARKET, 'open_position')).toEqual({
      ok: true,
      label: 'Open a perp position on Noether',
    })
  })

  it('labels an open through the router', () => {
    expect(labelForCall(NOETHER_ROUTER, 'open_with_price')).toEqual({
      ok: true,
      label: 'Open a perp position on Noether',
    })
  })

  it('refuses a close, which no builder here produces', () => {
    const out = labelForCall(NOETHER_MARKET, 'close_position')
    expect(out.ok).toBe(false)
  })
})
