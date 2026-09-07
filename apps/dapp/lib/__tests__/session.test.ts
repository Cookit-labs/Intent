import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Session token rules.
 *
 * These are the checks standing between an unauthenticated visitor and the
 * whole dApp, so each failure mode gets its own test rather than being folded
 * into a single happy-path assertion.
 */

const SECRET = 'a'.repeat(48)

beforeEach(() => {
  process.env['AUTH_SECRET'] = SECRET
})

async function load() {
  // Imported fresh per test so the module reads the env set above.
  return import('../server/session')
}

describe('createSession / readSession', () => {
  it('round-trips an email', async () => {
    const { createSession, readSession } = await load()
    const token = createSession('user@test.com')
    expect(readSession(token)?.email).toBe('user@test.com')
  })

  it('rejects a tampered payload', async () => {
    const { createSession, readSession } = await load()
    const token = createSession('user@test.com')
    const [, signature] = token.split('.')

    // Re-encode a different email but keep the original signature — the exact
    // move someone would try after reading their own cookie.
    const forged = Buffer.from(
      JSON.stringify({ email: 'attacker@test.com', exp: Math.floor(Date.now() / 1000) + 999 })
    ).toString('base64url')

    expect(readSession(`${forged}.${signature ?? ''}`)).toBeUndefined()
  })

  it('rejects a token signed with a different secret', async () => {
    const { createSession, readSession } = await load()
    const token = createSession('user@test.com')

    // The secret is read per call, so swapping it here is enough to model a
    // token minted by a different deployment.
    process.env['AUTH_SECRET'] = 'b'.repeat(48)
    expect(readSession(token)).toBeUndefined()
  })

  it('rejects an expired token', async () => {
    const { createSession, readSession } = await load()
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000
    const token = createSession('user@test.com', past)
    expect(readSession(token)).toBeUndefined()
  })

  it('accepts a token that has not yet expired', async () => {
    const { createSession, readSession } = await load()
    const token = createSession('user@test.com')
    expect(readSession(token, Date.now() + 60_000)).toBeDefined()
  })

  it.each([undefined, '', 'garbage', 'only.two.parts.here', 'no-dot'])(
    'rejects malformed input %j',
    async (value) => {
      const { readSession } = await load()
      expect(readSession(value as string | undefined)).toBeUndefined()
    }
  )
})
