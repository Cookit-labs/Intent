import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SESSION_COOKIE, createSession } from '../server/session'

/**
 * The guards on the standing-rules routes.
 *
 * Two different gates. The rule routes and the inbox are scoped by the
 * session cookie: without one there is no owner to scope by, so they answer
 * 401 before touching the database. The tick is called by a scheduler, not a
 * person, and is guarded by a shared secret instead — and refuses to run at
 * all when no secret is configured, because an open tick would let anyone on
 * the internet trigger emails to every user with a due rule.
 *
 * Only the gates are tested here. What a route does once it is through them
 * is the repository's and the tick's behaviour, covered in their own tests.
 */

const SECRET = 'a'.repeat(48)
const TICK_SECRET = 't'.repeat(32)

beforeEach(() => {
  process.env['AUTH_SECRET'] = SECRET
  delete process.env['STANDING_TICK_SECRET']
})

afterEach(() => {
  delete process.env['STANDING_TICK_SECRET']
})

function withSession(init: RequestInit = {}, url = 'http://localhost/api/standing'): Request {
  const token = createSession('alice@test.com')
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `${SESSION_COOKIE}=${token}` },
  })
}

describe('the rules route', () => {
  it('answers 401 without a session on every method', async () => {
    const { DELETE, GET, PATCH, POST } = await import('../../app/api/standing/route')
    const url = 'http://localhost/api/standing?chain=stellar'

    expect((await GET(new Request(url))).status).toBe(401)
    expect((await POST(new Request(url, { method: 'POST', body: '{}' }))).status).toBe(401)
    expect((await PATCH(new Request(url, { method: 'PATCH', body: '{}' }))).status).toBe(401)
    expect((await DELETE(new Request(`${url}&id=x`, { method: 'DELETE' }))).status).toBe(401)
  })

  it('rejects a malformed rule before touching the database', async () => {
    // No DATABASE_URL is set in this test, so reaching the pool would throw
    // and the response would be a 500 rather than a 400.
    const { POST } = await import('../../app/api/standing/route')

    const res = await POST(
      withSession({
        method: 'POST',
        body: JSON.stringify({ wallet: 'G'.padEnd(56, 'A'), rule: { id: 'x' } }),
      })
    )

    expect(res.status).toBe(400)
  })

  it('rejects an expired session', async () => {
    const { GET } = await import('../../app/api/standing/route')
    const expired = createSession('alice@test.com', Date.now() - 30 * 24 * 3600 * 1000)

    const res = await GET(
      new Request('http://localhost/api/standing?chain=stellar', {
        headers: { cookie: `${SESSION_COOKIE}=${expired}` },
      })
    )

    expect(res.status).toBe(401)
  })
})

describe('the inbox route', () => {
  it('answers 401 without a session', async () => {
    const { GET, POST } = await import('../../app/api/standing/inbox/route')
    const url = 'http://localhost/api/standing/inbox?chain=stellar'

    expect((await GET(new Request(url))).status).toBe(401)
    expect((await POST(new Request(url, { method: 'POST', body: '{"ids":[]}' }))).status).toBe(401)
  })
})

describe('the tick route', () => {
  // The first import of the route pays for its whole graph, and that graph
  // carries the Stellar SDK through the price readers — several seconds
  // under vitest on a cold cache, which is most of the default budget.
  const COLD_IMPORT_MS = 30_000

  it(
    'refuses to run when no secret is configured',
    async () => {
      const { POST } = await import('../../app/api/standing/tick/route')

      const res = await POST(
        new Request('http://localhost/api/standing/tick', {
          method: 'POST',
          headers: { 'x-tick-secret': 'anything' },
        })
      )

      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toMatch(/STANDING_TICK_SECRET/)
    },
    COLD_IMPORT_MS
  )

  it('answers 403 to the wrong secret', async () => {
    process.env['STANDING_TICK_SECRET'] = TICK_SECRET
    const { POST } = await import('../../app/api/standing/tick/route')

    const wrong = await POST(
      new Request('http://localhost/api/standing/tick', {
        method: 'POST',
        headers: { 'x-tick-secret': 'x'.repeat(32) },
      })
    )
    const missing = await POST(
      new Request('http://localhost/api/standing/tick', { method: 'POST' })
    )

    expect(wrong.status).toBe(403)
    expect(missing.status).toBe(403)
  })

  it('does not accept the secret from a session cookie', async () => {
    // The tick is for schedulers. A signed-in user is not a scheduler.
    process.env['STANDING_TICK_SECRET'] = TICK_SECRET
    const { POST } = await import('../../app/api/standing/tick/route')

    const res = await POST(withSession({ method: 'POST' }, 'http://localhost/api/standing/tick'))

    expect(res.status).toBe(403)
  })
})
