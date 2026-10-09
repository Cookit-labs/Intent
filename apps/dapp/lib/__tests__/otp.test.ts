import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it } from 'vitest'

import { CODE_TTL_SECONDS, createOtpStore, type OtpStore } from '../server/otp'
import { fakeOtpDb, type FakeOtpDb } from './fakes/otp-db'

/**
 * The sign-in code store. These are the rules that make a six digit secret safe to
 * hand out: codes are kept hashed, live ten minutes, die after five wrong tries, are
 * used once, and an address cannot be spammed with them.
 */

const EMAIL = 'tester@example.com'
const OTHER = 'someone-else@example.com'

let db: FakeOtpDb
let store: OtpStore

beforeEach(() => {
  db = fakeOtpDb()
  store = createOtpStore(db.query)
})

describe('issuing a code', () => {
  it('returns six digits', async () => {
    for (let i = 0; i < 20; i++) {
      db = fakeOtpDb()
      store = createOtpStore(db.query)
      expect(await store.issueCode(EMAIL)).toMatch(/^\d{6}$/)
    }
  })

  it('keeps only a hash of the code, never the code itself', async () => {
    const code = await store.issueCode(EMAIL)
    const row = db.rows.get(EMAIL)
    expect(row?.code_hash).toBe(createHash('sha256').update(code).digest('hex'))
    expect(JSON.stringify([...db.rows.values()])).not.toContain(code)
    expect(JSON.stringify(db.log)).not.toContain(code)
  })

  it('lasts ten minutes', async () => {
    expect(CODE_TTL_SECONDS).toBe(600)
    await store.issueCode(EMAIL)
    const row = db.rows.get(EMAIL)
    expect((row?.expires_at ?? 0) - db.now()).toBe(600 * 1000)
  })
})

describe('verifying a code', () => {
  it('accepts the right code once', async () => {
    const code = await store.issueCode(EMAIL)
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: true })
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('lets only one of two simultaneous right answers through', async () => {
    const code = await store.issueCode(EMAIL)
    const [a, b] = await Promise.all([store.verifyCode(EMAIL, code), store.verifyCode(EMAIL, code)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })

  it('refuses a wrong code, and the right one still works afterwards', async () => {
    const code = await store.issueCode(EMAIL)
    const wrong = code === '000000' ? '000001' : '000000'
    expect(await store.verifyCode(EMAIL, wrong)).toEqual({ ok: false, reason: 'invalid' })
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: true })
  })

  it('kills the code after five wrong tries, even for the right answer', async () => {
    const code = await store.issueCode(EMAIL)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++) {
      expect(await store.verifyCode(EMAIL, wrong)).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: false, reason: 'too_many_attempts' })
    expect(await store.verifyCode(EMAIL, code)).toEqual({ ok: false, reason: 'expired' })
  })

  it('counts the right code as a try too: the sixth attempt is refused', async () => {
    const code = await store.issueCode(EMAIL)
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 5; i++) await store.verifyCode(EMAIL, wrong)
    expect((await store.verifyCode(EMAIL, code)).ok).toBe(false)
  })

  it('expires after ten minutes', async () => {
    const code = await store.issueCode(EMAIL)
    db.advance(599)
    expect((await store.verifyCode(EMAIL, code)).ok).toBe(true)

    const later = await store.issueCode(EMAIL)
    db.advance(601)
    expect(await store.verifyCode(EMAIL, later)).toEqual({ ok: false, reason: 'expired' })
  })

  it('knows nothing about an address that never asked', async () => {
    expect(await store.verifyCode(EMAIL, '123456')).toEqual({ ok: false, reason: 'expired' })
  })

  it('keeps each address on its own', async () => {
    const mine = await store.issueCode(EMAIL)
    const theirs = await store.issueCode(OTHER)
    if (mine !== theirs) {
      expect((await store.verifyCode(OTHER, mine)).ok).toBe(false)
    }
    expect((await store.verifyCode(EMAIL, mine)).ok).toBe(true)
    expect((await store.verifyCode(OTHER, theirs)).ok).toBe(true)
  })

  it('replaces the old code and clears the tries when a new one is issued', async () => {
    const first = await store.issueCode(EMAIL)
    const wrong = first === '000000' ? '000001' : '000000'
    for (let i = 0; i < 4; i++) await store.verifyCode(EMAIL, wrong)

    db.advance(61)
    const second = await store.issueCode(EMAIL)
    expect(db.rows.get(EMAIL)?.attempts).toBe(0)
    if (second !== first) expect((await store.verifyCode(EMAIL, first)).ok).toBe(false)
    expect((await store.verifyCode(EMAIL, second)).ok).toBe(true)
  })
})

describe('how often an address can ask', () => {
  it('lets a first request through', async () => {
    expect(await store.checkSendRateLimit(EMAIL)).toEqual({ allowed: true, retryAfter: 0 })
  })

  it('makes an address wait a minute between codes', async () => {
    await store.issueCode(EMAIL)
    expect(await store.checkSendRateLimit(EMAIL)).toEqual({
      allowed: false,
      retryAfter: 60,
      reason: 'cooldown',
    })
    db.advance(30)
    expect(await store.checkSendRateLimit(EMAIL)).toMatchObject({
      retryAfter: 30,
      reason: 'cooldown',
    })
    db.advance(31)
    expect(await store.checkSendRateLimit(EMAIL)).toEqual({ allowed: true, retryAfter: 0 })
  })

  it('stops at five codes an hour and says when to come back', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await store.checkSendRateLimit(EMAIL)).allowed).toBe(true)
      await store.issueCode(EMAIL)
      db.advance(61)
    }
    const blocked = await store.checkSendRateLimit(EMAIL)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('hourly')
    expect(blocked.retryAfter).toBeGreaterThan(3000)
    expect(blocked.retryAfter).toBeLessThanOrEqual(3600)
  })

  it('starts counting again once an hour has passed without a send', async () => {
    for (let i = 0; i < 5; i++) {
      await store.issueCode(EMAIL)
      db.advance(61)
    }
    db.advance(3600)
    expect(await store.checkSendRateLimit(EMAIL)).toEqual({ allowed: true, retryAfter: 0 })
    await store.issueCode(EMAIL)
    expect(db.rows.get(EMAIL)?.sends).toBe(1)
  })

  it('counts each address on its own', async () => {
    await store.issueCode(EMAIL)
    expect((await store.checkSendRateLimit(OTHER)).allowed).toBe(true)
  })
})

describe('when the database is down', () => {
  it('fails every call, so nobody gets in on an error', async () => {
    db.down = new Error('connection refused')
    await expect(store.issueCode(EMAIL)).rejects.toThrow('connection refused')
    await expect(store.verifyCode(EMAIL, '123456')).rejects.toThrow('connection refused')
    await expect(store.checkSendRateLimit(EMAIL)).rejects.toThrow('connection refused')
  })
})
