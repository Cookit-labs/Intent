import { describe, expect, it } from 'vitest'

import { USDC, XLM, toBaseUnits } from '../swap/assets'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'

/** A recorded Horizon reply, so the parser is tested without a network. */
function respond(payload: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status }))) as unknown as typeof fetch
}

const RECORDED = {
  _embedded: {
    records: [
      {
        source_amount: '30.0000000',
        destination_amount: '51.4834232',
        destination_asset_type: 'credit_alphanum4',
        path: [],
      },
    ],
  },
}

describe('horizon quoter', () => {
  it('parses a real recorded route into base units', async () => {
    const q = createHorizonQuoter({ fetchImpl: respond(RECORDED) })
    const out = await q.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: toBaseUnits('30'),
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.quote.sendAmount).toBe('300000000')
    expect(out.quote.destAmount).toBe('514834232')
    expect(out.quote.source).toBe('horizon')
    expect(out.quote.path).toEqual([])
  })

  it('reports no route rather than failing loudly', async () => {
    // A thin pair is an ordinary outcome, not a fault.
    const q = createHorizonQuoter({ fetchImpl: respond({ _embedded: { records: [] } }) })
    const out = await q.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '1' })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.reason).toBe('no_route')
  })

  it('picks the best of several candidates, not the first', async () => {
    const q = createHorizonQuoter({
      fetchImpl: respond({
        _embedded: {
          records: [
            { source_amount: '30', destination_amount: '40', path: [] },
            { source_amount: '30', destination_amount: '55', path: [] },
            { source_amount: '30', destination_amount: '45', path: [] },
          ],
        },
      }),
    })
    const out = await q.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '300000000' })
    if (!out.ok) throw new Error('expected a quote')
    expect(out.quote.destAmount).toBe(toBaseUnits('55'))
  })

  it('prefers the cheapest input on a fixed output', async () => {
    // Direction flips on strict_receive and is easy to get backwards.
    const q = createHorizonQuoter({
      fetchImpl: respond({
        _embedded: {
          records: [
            { source_amount: '31', destination_amount: '50', path: [] },
            { source_amount: '29', destination_amount: '50', path: [] },
          ],
        },
      }),
    })
    const out = await q.quote({
      kind: 'strict_receive',
      from: XLM,
      to: USDC,
      receiveAmount: toBaseUnits('50'),
    })
    if (!out.ok) throw new Error('expected a quote')
    expect(out.quote.sendAmount).toBe(toBaseUnits('29'))
  })

  it('preserves multi-hop paths exactly', async () => {
    // A different path is a different price, so hops must replay verbatim.
    const q = createHorizonQuoter({
      fetchImpl: respond({
        _embedded: {
          records: [
            {
              source_amount: '30',
              destination_amount: '50',
              path: [{ asset_type: 'credit_alphanum4', asset_code: 'AQUA', asset_issuer: 'GABC' }],
            },
          ],
        },
      }),
    })
    const out = await q.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '300000000' })
    if (!out.ok) throw new Error('expected a quote')
    expect(out.quote.path).toHaveLength(1)
    expect(out.quote.path[0]).toMatchObject({ code: 'AQUA', issuer: 'GABC' })
  })

  it('maps an upstream error without throwing', async () => {
    const q = createHorizonQuoter({ fetchImpl: respond({ error: 'boom' }, 503) })
    const out = await q.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '1' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('upstream_error')
  })

  it('reports an aborted request as a timeout', async () => {
    const q = createHorizonQuoter({
      fetchImpl: (() => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        return Promise.reject(e)
      }) as unknown as typeof fetch,
    })
    const out = await q.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '1' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('timeout')
  })
})
