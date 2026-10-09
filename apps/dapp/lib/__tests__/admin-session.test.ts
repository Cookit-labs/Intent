import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ADMIN_COOKIE,
  ADMIN_TTL_SECONDS,
  adminTokenMatches,
  createAdminSession,
  isAdminRequest,
  readAdminSession,
} from '../server/admin-session'
import { createSession } from '../server/session'

const SECRET = 'a'.repeat(40)
const TOKEN = 'an-admin-token-of-length'

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET)
  vi.stubEnv('ADMIN_TOKEN', TOKEN)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/admin/anything', { headers })
}

describe('the admin token', () => {
  it('matches only the configured token', () => {
    expect(adminTokenMatches(TOKEN)).toBe(true)
    expect(adminTokenMatches('another-token-of-length')).toBe(false)
    expect(adminTokenMatches('')).toBe(false)
    expect(adminTokenMatches(undefined)).toBe(false)
    expect(adminTokenMatches(null)).toBe(false)
  })

  it('matches nothing when none is configured or it is too short', () => {
    vi.stubEnv('ADMIN_TOKEN', '')
    expect(adminTokenMatches('')).toBe(false)
    vi.stubEnv('ADMIN_TOKEN', 'short')
    expect(adminTokenMatches('short')).toBe(false)
  })
})

describe('the admin session cookie', () => {
  it('is read back as a session', () => {
    expect(readAdminSession(createAdminSession())).toBe(true)
  })

  it('expires after its lifetime', () => {
    const now = Date.now()
    const token = createAdminSession(now)
    expect(readAdminSession(token, now + (ADMIN_TTL_SECONDS - 5) * 1000)).toBe(true)
    expect(readAdminSession(token, now + (ADMIN_TTL_SECONDS + 5) * 1000)).toBe(false)
  })

  it('is refused once tampered with', () => {
    const [encoded, signature] = (createAdminSession() as string).split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ role: 'admin', exp: 9_999_999_999 })).toString(
      'base64url'
    )
    expect(readAdminSession(`${forged}.${signature}`)).toBe(false)
    expect(readAdminSession(`${encoded}.${signature.slice(0, -2)}xx`)).toBe(false)
  })

  it('is refused when signed with another secret', () => {
    const token = createAdminSession()
    vi.stubEnv('AUTH_SECRET', 'b'.repeat(40))
    expect(readAdminSession(token)).toBe(false)
  })

  it('is not a tester session, and a tester session is not an admin one', () => {
    expect(readAdminSession(createSession('tester@example.com'))).toBe(false)
  })

  it('cannot be made, or read, without a secret to sign with', () => {
    const token = createAdminSession()
    vi.stubEnv('AUTH_SECRET', 'too-short')
    expect(createAdminSession()).toBeUndefined()
    expect(readAdminSession(token)).toBe(false)
  })

  it('refuses hostile input without throwing', () => {
    for (const junk of [undefined, '', 'x', 'a.b.c', '....', '%%.%%', 'e30.e30']) {
      expect(readAdminSession(junk)).toBe(false)
    }
  })
})

describe('what counts as an admin request', () => {
  it('accepts a valid session cookie', () => {
    const cookie = `other=1; ${ADMIN_COOKIE}=${encodeURIComponent(createAdminSession() as string)}`
    expect(isAdminRequest(request({ cookie }))).toBe(true)
  })

  it('accepts the token in a header, for scripts', () => {
    expect(isAdminRequest(request({ 'x-admin-token': TOKEN }))).toBe(true)
  })

  it('refuses a wrong token, a bad cookie and nothing at all', () => {
    expect(isAdminRequest(request({ 'x-admin-token': 'nope-nope-nope-nope' }))).toBe(false)
    expect(isAdminRequest(request({ cookie: `${ADMIN_COOKIE}=garbage` }))).toBe(false)
    expect(isAdminRequest(request({}))).toBe(false)
  })

  it('refuses a tester session cookie presented as an admin one', () => {
    const cookie = `${ADMIN_COOKIE}=${encodeURIComponent(createSession('tester@example.com'))}`
    expect(isAdminRequest(request({ cookie }))).toBe(false)
  })
})
