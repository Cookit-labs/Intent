import { describe, expect, it, vi } from 'vitest'

/**
 * Every POST route asks the limiter before it reads its body.
 *
 * The limiter is faked to refuse everything, and each route is sent a body
 * it could never accept. A route that consulted the limiter first answers
 * 429; one that parsed first would answer 400. The tick is the one POST
 * route not here: it is called by a scheduler and guarded by its secret.
 */

vi.mock('../server/rate-limit', () => ({
  enforceRateLimit: vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'rate_limited', retryAfter: 7 }), { status: 429 })
  ),
}))

type Route = { POST: (request: Request) => Promise<Response> }

const ROUTES: Record<string, () => Promise<Route>> = {
  'admin/waitlist': () => import('../../app/api/admin/waitlist/route'),
  'agents/compete': () => import('../../app/api/agents/compete/route'),
  'auth/logout': () => import('../../app/api/auth/logout/route'),
  'auth/request-otp': () => import('../../app/api/auth/request-otp/route'),
  'auth/verify-otp': () => import('../../app/api/auth/verify-otp/route'),
  'intent/parse': () => import('../../app/api/intent/parse/route'),
  'lend/borrow': () => import('../../app/api/lend/borrow/route'),
  'lend/build': () => import('../../app/api/lend/build/route'),
  'lend/collateral': () => import('../../app/api/lend/collateral/route'),
  'lend/defindex/build': () => import('../../app/api/lend/defindex/build/route'),
  'lend/defindex/submit': () => import('../../app/api/lend/defindex/submit/route'),
  'lend/repay': () => import('../../app/api/lend/repay/route'),
  'lend/submit': () => import('../../app/api/lend/submit/route'),
  'lend/withdraw': () => import('../../app/api/lend/withdraw/route'),
  'offers/build': () => import('../../app/api/offers/build/route'),
  'offers/submit': () => import('../../app/api/offers/submit/route'),
  'offramp/build': () => import('../../app/api/offramp/build/route'),
  'offramp/submit': () => import('../../app/api/offramp/submit/route'),
  'perps/prepare': () => import('../../app/api/perps/prepare/route'),
  'perps/session': () => import('../../app/api/perps/session/route'),
  'perps/submit': () => import('../../app/api/perps/submit/route'),
  'plan/build': () => import('../../app/api/plan/build/route'),
  'plan/submit': () => import('../../app/api/plan/submit/route'),
  'send/build': () => import('../../app/api/send/build/route'),
  'send/resolve': () => import('../../app/api/send/resolve/route'),
  'send/submit': () => import('../../app/api/send/submit/route'),
  standing: () => import('../../app/api/standing/route'),
  'standing/inbox': () => import('../../app/api/standing/inbox/route'),
  'swap/build': () => import('../../app/api/swap/build/route'),
  'swap/quote': () => import('../../app/api/swap/quote/route'),
  'swap/submit': () => import('../../app/api/swap/submit/route'),
  waitlist: () => import('../../app/api/waitlist/route'),
}

/**
 * Most of each case is the route's first import: the competition route
 * alone pulls in the agents and their providers and takes a few seconds on
 * a quiet machine, more on a loaded one. The limit is for that, not for
 * anything the route does.
 */
const IMPORT_TIMEOUT_MS = 30_000

describe('the limiter runs first on every POST route', () => {
  for (const [path, load] of Object.entries(ROUTES)) {
    it(
      `api/${path}`,
      async () => {
        const { POST } = await load()
        const res = await POST(
          new Request(`http://localhost/api/${path}`, { method: 'POST', body: 'not json' })
        )
        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 7 })
      },
      IMPORT_TIMEOUT_MS
    )
  }
})
