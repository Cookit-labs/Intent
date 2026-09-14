import { describe, expect, it } from 'vitest'

import { deliveredFromResultXdr } from '../swap/delivered'
import { submitSignedSwap } from '../swap/submit'

/**
 * Sizing the second step from what the first actually delivered.
 *
 * The property that makes a two-signature sequence worth having rather than
 * merely tolerable. An atomic version would have to name the supply amount in
 * advance, from a quote taken before the swap ran; a sequence knows the real
 * figure because the swap has already settled.
 *
 * The failure mode being guarded is subtle: a plausible fallback. Supplying an
 * estimate when the real figure cannot be read would either strand dust or fail
 * for insufficient balance, and both look like bugs elsewhere. Stopping is the
 * correct behaviour, so it is tested as carefully as the success path.
 */

/** A settled `pathPaymentStrictSend` delivering 7777777 stroops. */
const DELIVERED_RESULT =
  'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAANAAAAAAAAAAEAAAABAAAAAHGwE9oV+txDRbTgnWhnL5D9MRAkXnPDanRcmH2LIjkJAAAAAAAAMDkAAAAAAAAAAACWtD8AAAAAAAAAAABAu/gAAAAAcbAT2hX63ENFtOCdaGcvkP0xECRec8NqdFyYfYsiOQkAAAAAAAAAAAB2rfEAAAAA'

function horizonReturning(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('a settled swap reports what it delivered', () => {
  it('carries the delivered amount through submission', async () => {
    const result = await submitSignedSwap('AAAA', {
      fetchImpl: horizonReturning({
        hash: 'abc123',
        ledger: 42,
        successful: true,
        result_xdr: DELIVERED_RESULT,
      }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.delivered).toBe('7777777')
  })

  it('reports no amount when Horizon returns no result', async () => {
    // Absent rather than zero. Zero is a number the caller could act on, and
    // acting on it would supply nothing while reporting success.
    const result = await submitSignedSwap('AAAA', {
      fetchImpl: horizonReturning({ hash: 'abc123', ledger: 42, successful: true }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.delivered).toBeUndefined()
  })

  it('reports no amount for a transaction that delivered nothing', async () => {
    // Placing an offer settles successfully and delivers nothing. A sequence
    // must not read that as a zero-sized supply.
    const result = await submitSignedSwap('AAAA', {
      fetchImpl: horizonReturning({
        hash: 'abc123',
        ledger: 42,
        successful: true,
        result_xdr: 'AAAAAAAAAGQAAAAAAAAAAA==',
      }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.delivered).toBeUndefined()
  })

  it('still fails a swap that did not succeed, whatever it reports', async () => {
    const result = await submitSignedSwap('AAAA', {
      fetchImpl: horizonReturning({
        hash: 'abc123',
        successful: false,
        extras: { result_codes: { operations: ['op_under_dest_min'] } },
      }),
    })

    expect(result.ok).toBe(false)
  })
})

describe('the delivered figure is the one to supply', () => {
  it('is what reached the account, not what an offer traded', () => {
    // A route through several offers has intermediate amounts that are not the
    // account's to supply.
    expect(deliveredFromResultXdr(DELIVERED_RESULT)).toBe('7777777')
  })

  it('is a string, so large amounts survive', () => {
    // Stroop amounts exceed what a float represents exactly. Returning a
    // number here would silently round real balances.
    expect(typeof deliveredFromResultXdr(DELIVERED_RESULT)).toBe('string')
  })
})
