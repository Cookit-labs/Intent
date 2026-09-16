import { describe, expect, it } from 'vitest'

import { USDC, XLM } from '../swap/assets'
import { createHorizonQuoter } from '../swap/sources/horizon-quoter'

/**
 * Several real routes, not one.
 *
 * Horizon returns every path it can find and they can differ enormously — for
 * one 50 USDC swap it offered 127.97 XLM through EURC and 53.52 direct, both
 * executable classic path payments. The quoter collapsed them with a `reduce`
 * and handed the agents a single option.
 *
 * That is why four agents kept agreeing: not because they could not think, but
 * because there was nothing to choose between. A competition over a list of
 * one is a formality.
 */

const twoPaths = {
  _embedded: {
    records: [
      {
        source_amount: '50.0000000',
        destination_amount: '127.9739438',
        path: [{ asset_type: 'credit_alphanum4', asset_code: 'EURC', asset_issuer: 'GEURC' }],
      },
      {
        source_amount: '50.0000000',
        destination_amount: '53.5200000',
        path: [],
      },
    ],
  },
}

function stub(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as never
}

describe('every executable path is offered', () => {
  const req = { kind: 'strict_send' as const, from: USDC, to: XLM, sendAmount: '500000000' }

  it('returns each distinct route rather than only the best', async () => {
    const quoter = createHorizonQuoter({ fetchImpl: stub(twoPaths) })
    const all = await quoter.quoteAll?.(req)

    expect(all?.ok).toBe(true)
    if (all?.ok) expect(all.quotes).toHaveLength(2)
  })

  it('orders them best first, so a ranking is still available', async () => {
    const quoter = createHorizonQuoter({ fetchImpl: stub(twoPaths) })
    const all = await quoter.quoteAll?.(req)

    if (all?.ok) {
      expect(BigInt(all.quotes[0]!.destAmount)).toBeGreaterThan(BigInt(all.quotes[1]!.destAmount))
    }
  })

  it('keeps each route its own path, so they build differently', async () => {
    const quoter = createHorizonQuoter({ fetchImpl: stub(twoPaths) })
    const all = await quoter.quoteAll?.(req)

    if (all?.ok) {
      // One hops through EURC, the other is direct. Replaying the wrong path
      // is a different trade at a different price.
      expect(all.quotes[0]?.path).toHaveLength(1)
      expect(all.quotes[1]?.path).toHaveLength(0)
    }
  })

  it('still answers the single-quote call with the best one', async () => {
    // The existing interface is unchanged: callers that want one answer get
    // the same answer they always did.
    const quoter = createHorizonQuoter({ fetchImpl: stub(twoPaths) })
    const one = await quoter.quote(req)

    expect(one.ok).toBe(true)
    if (one.ok) expect(one.quote.destAmount).toBe('1279739438')
  })

  it('reports no route when nothing comes back', async () => {
    const quoter = createHorizonQuoter({ fetchImpl: stub({ _embedded: { records: [] } }) })
    const all = await quoter.quoteAll?.(req)

    expect(all?.ok).toBe(false)
    if (all !== undefined && !all.ok) expect(all.failure.reason).toBe('no_route')
  })
})
