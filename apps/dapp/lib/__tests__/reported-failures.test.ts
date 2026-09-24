import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A swallowed upstream failure now leaves a mark.
 *
 * The routes that answer 502 when Horizon or a pool cannot be read used to
 * do so silently: the client saw an error code and nobody else saw anything.
 * They still answer exactly as before — the response is the contract — and
 * now also say so where an operator looks. One route stands for the pattern;
 * the lend routes and the offer builder are the same two lines.
 */

describe('GET /api/offers when Horizon is unreachable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('still answers 502 horizon_unreachable, and reports it with the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { GET } = await import('../../app/api/offers/route')

    const res = await GET(new Request('http://localhost/api/offers?account=GABC'))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'horizon_unreachable' })
    const lines = error.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.startsWith('[offers] '))).toHaveLength(1)
    expect(lines[0]).toContain('{"account":"GABC"}')
  })
})
