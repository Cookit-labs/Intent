import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RATE_LIMIT_DEFAULTS,
  checkRateLimit,
  createRateLimiter,
  enforceRateLimit,
  limitFor,
  type RateLimiter,
} from '../server/rate-limit'
import { fakeRateLimitDb, type FakeRateLimitDb } from './fakes/rate-limit-db'

/**
 * Fixed-window rate limits, counted in Postgres.
 *
 * The arithmetic is what matters: which window a request lands in, when the
 * count refuses, how long the caller is told to wait, and that the next
 * window starts clean. All of it runs over the in-memory fake; the SQL
 * itself is checked by the live test.
 *
 * The other property pinned here is the failure rule. A limiter exists to
 * keep the app up under abuse, so one that cannot reach its own store lets
 * the request through and says so once, rather than turning a database
 * blip into an outage.
 */

/** Thirty seconds into the sixty-second window that starts at 10:00:00. */
const T0 = new Date('2026-09-24T10:00:30.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

let db: FakeRateLimitDb
let limiter: RateLimiter

beforeEach(() => {
  db = fakeRateLimitDb()
  limiter = createRateLimiter(db.query)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createRateLimiter', () => {
  it('allows the first request in a window and says how many remain', async () => {
    const decision = await limiter.check({
      key: 'ip:1.2.3.4:build',
      limit: 3,
      windowSeconds: 60,
      now: T0,
    })
    expect(decision).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 })
  })

  it('refuses past the limit, with the seconds left in the window', async () => {
    const input = { key: 'ip:1.2.3.4:build', limit: 3, windowSeconds: 60, now: T0 }
    await limiter.check(input)
    await limiter.check(input)
    expect((await limiter.check(input)).allowed).toBe(true)

    // Forty seconds into the window: twenty to go.
    const refused = await limiter.check({ ...input, now: at(10) })
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 20 })
  })

  it('rounds the wait up to a whole second', async () => {
    const input = { key: 'k', limit: 1, windowSeconds: 60 }
    await limiter.check({ ...input, now: T0 })
    const refused = await limiter.check({ ...input, now: at(0.5) })
    expect(refused.retryAfterSeconds).toBe(30)
  })

  it('aligns the window to the clock, so two requests share one count', async () => {
    await limiter.check({ key: 'k', limit: 5, windowSeconds: 60, now: T0 })
    await limiter.check({ key: 'k', limit: 5, windowSeconds: 60, now: at(20) })
    expect([...db.counts.entries()]).toEqual([['k|2026-09-24T10:00:00.000Z', 2]])
  })

  it('starts a fresh count when the window rolls over', async () => {
    const input = { key: 'k', limit: 1, windowSeconds: 60 }
    expect((await limiter.check({ ...input, now: T0 })).allowed).toBe(true)
    expect((await limiter.check({ ...input, now: at(1) })).allowed).toBe(false)

    // 10:01:00 is a new window.
    const next = await limiter.check({ ...input, now: at(30) })
    expect(next).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
  })

  it('purges windows that started before the cut-off', async () => {
    await limiter.check({ key: 'old', limit: 5, windowSeconds: 60, now: at(-3600) })
    await limiter.check({ key: 'new', limit: 5, windowSeconds: 60, now: T0 })

    await limiter.purge(at(-60))
    expect([...db.counts.keys()]).toEqual(['new|2026-09-24T10:00:00.000Z'])
  })
})

describe('limitFor', () => {
  it('has a default for every family', () => {
    for (const family of ['build', 'submit', 'compete', 'resolve', 'standing', 'auth'] as const) {
      expect(limitFor(family, {})).toEqual(RATE_LIMIT_DEFAULTS[family])
      expect(RATE_LIMIT_DEFAULTS[family].limit).toBeGreaterThan(0)
      expect(RATE_LIMIT_DEFAULTS[family].windowSeconds).toBeGreaterThan(0)
    }
  })

  it('reads RATE_LIMIT_<FAMILY> as count/seconds', () => {
    expect(limitFor('build', { RATE_LIMIT_BUILD: '5/10' })).toEqual({ limit: 5, windowSeconds: 10 })
    expect(limitFor('auth', { RATE_LIMIT_AUTH: ' 100 / 3600 ' })).toEqual({
      limit: 100,
      windowSeconds: 3600,
    })
  })

  it('keeps the default when the override cannot be read', () => {
    expect(limitFor('build', { RATE_LIMIT_BUILD: 'lots' })).toEqual(RATE_LIMIT_DEFAULTS.build)
    expect(limitFor('build', { RATE_LIMIT_BUILD: '0/60' })).toEqual(RATE_LIMIT_DEFAULTS.build)
    expect(limitFor('build', { RATE_LIMIT_BUILD: '5/0' })).toEqual(RATE_LIMIT_DEFAULTS.build)
    expect(limitFor('build', { RATE_LIMIT_SUBMIT: '5/10' })).toEqual(RATE_LIMIT_DEFAULTS.build)
  })
})

describe('checkRateLimit', () => {
  it('decides through the limiter it is given', async () => {
    const input = { key: 'k', limit: 1, windowSeconds: 60 }
    const deps = { limiter: async () => limiter }
    expect((await checkRateLimit(input, deps)).allowed).toBe(true)
    expect((await checkRateLimit(input, deps)).allowed).toBe(false)
  })

  it('allows, and warns once per process, when the database is unreachable', async () => {
    // A fresh module, so the once-per-process flag starts clear here.
    vi.resetModules()
    const fresh = await import('../server/rate-limit')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    db.down = new Error('connect ECONNREFUSED 127.0.0.1:55432')
    const input = { key: 'k', limit: 3, windowSeconds: 60 }
    const deps = { limiter: async () => fresh.createRateLimiter(db.query) }

    expect(await fresh.checkRateLimit(input, deps)).toEqual({
      allowed: true,
      remaining: 3,
      retryAfterSeconds: 0,
    })
    expect((await fresh.checkRateLimit(input, deps)).allowed).toBe(true)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[rate-limit]')
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED')
  })

  it('allows when the database does not answer in time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hanging = createRateLimiter(
      () => new Promise<{ rows: Record<string, unknown>[] }>(() => undefined)
    )
    const decision = await checkRateLimit(
      { key: 'k', limit: 3, windowSeconds: 60 },
      { limiter: async () => hanging, timeoutMs: 20 }
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('enforceRateLimit', () => {
  function post(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/swap/build', { method: 'POST', headers, body: '{}' })
  }
  const deps = (env: Record<string, string> = {}) => ({ limiter: async () => limiter, env })

  it('lets a request through under the limit', async () => {
    const out = await enforceRateLimit(
      post({ 'x-forwarded-for': '1.2.3.4' }),
      'build',
      undefined,
      deps()
    )
    expect(out).toBeUndefined()
  })

  it('answers 429 with Retry-After once the family limit is spent', async () => {
    const env = { RATE_LIMIT_SUBMIT: '2/60' }
    const req = (): Request => post({ 'x-forwarded-for': '1.2.3.4' })
    expect(await enforceRateLimit(req(), 'submit', undefined, deps(env))).toBeUndefined()
    expect(await enforceRateLimit(req(), 'submit', undefined, deps(env))).toBeUndefined()

    const res = await enforceRateLimit(req(), 'submit', undefined, deps(env))
    expect(res?.status).toBe(429)
    const retry = Number(res?.headers.get('Retry-After'))
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
    expect(await res?.json()).toEqual({ error: 'rate_limited', retryAfter: retry })
  })

  it('keys on the first hop of x-forwarded-for, then x-real-ip, then unknown', async () => {
    await enforceRateLimit(
      post({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }),
      'build',
      undefined,
      deps()
    )
    await enforceRateLimit(post({ 'x-real-ip': '8.8.8.8' }), 'build', undefined, deps())
    await enforceRateLimit(post(), 'build', undefined, deps())

    expect([...db.counts.keys()].map((k) => k.split('|')[0])).toEqual([
      'ip:9.9.9.9:build',
      'ip:8.8.8.8:build',
      'ip:unknown:build',
    ])
  })

  it('counts a hop too long to be an address as unknown', async () => {
    // A client can send any x-forwarded-for it likes. One long enough to
    // fail the key's index would otherwise turn into "database unreachable"
    // and an allow; here it shares the unknown bucket instead.
    await enforceRateLimit(post({ 'x-forwarded-for': 'x'.repeat(65) }), 'build', undefined, deps())
    await enforceRateLimit(
      post({ 'x-forwarded-for': '2001:0db8:85a3:0000:0000:8a2e:0370:7334' }),
      'build',
      undefined,
      deps()
    )

    expect([...db.counts.keys()].map((k) => k.split('|')[0])).toEqual([
      'ip:unknown:build',
      'ip:2001:0db8:85a3:0000:0000:8a2e:0370:7334:build',
    ])
  })

  it('also counts the account when one is given', async () => {
    const env = { RATE_LIMIT_SUBMIT: '1/60' }
    const account = 'G'.padEnd(56, 'A')
    const first = await enforceRateLimit(
      post({ 'x-forwarded-for': '1.1.1.1' }),
      'submit',
      account,
      deps(env)
    )
    expect(first).toBeUndefined()

    // A different address, the same account: refused on the account key.
    const second = await enforceRateLimit(
      post({ 'x-forwarded-for': '2.2.2.2' }),
      'submit',
      account,
      deps(env)
    )
    expect(second?.status).toBe(429)
  })
})
