import { describe, expect, it, vi } from 'vitest'

/**
 * The GET routes that reach a third party or the database consult the
 * limiter first. Faked to refuse everything, each is sent a request it
 * could never accept: a route that checked the limiter answers 429, one
 * that validated first would answer 400.
 */

vi.mock('../server/rate-limit', () => ({
  enforceRateLimit: vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'rate_limited', retryAfter: 7 }), { status: 429 })
  ),
}))

type Route = { GET: (request: Request) => Promise<Response> }

const ROUTES: Record<string, () => Promise<Route>> = {
  offers: () => import('../../app/api/offers/route'),
  'perps/session': () => import('../../app/api/perps/session/route'),
  sponsor: () => import('../../app/api/sponsor/route') as unknown as Promise<Route>,
}

describe('the limiter runs first on GET routes that call out', () => {
  for (const [path, load] of Object.entries(ROUTES)) {
    it(`api/${path}`, async () => {
      const { GET } = await load()
      const res = await GET(new Request(`http://localhost/api/${path}`))
      expect(res.status).toBe(429)
    }, 30_000)
  }
})
