import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => undefined) }))

import { DELETE, GET, POST } from '../../app/api/admin/session/route'
import { ADMIN_COOKIE } from '../server/admin-session'

const TOKEN = 'an-admin-token-of-length'

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(40))
  vi.stubEnv('ADMIN_TOKEN', TOKEN)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function post(body: unknown): Request {
  return new Request('http://localhost/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/admin/session', () => {
  it('turns the right token into an http-only, strict cookie', async () => {
    const res = await POST(post({ token: ` ${TOKEN} ` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: true })

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${ADMIN_COOKIE}=`)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=strict/i)
    expect(cookie).not.toContain(TOKEN)
  })

  it('refuses a wrong token and sets nothing', async () => {
    const res = await POST(post({ token: 'wrong-wrong-wrong-wrong' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a missing token and a body that is not JSON', async () => {
    expect((await POST(post({}))).status).toBe(401)
    expect((await POST(post({ token: 42 }))).status).toBe(401)
    expect((await POST(post('not json'))).status).toBe(400)
  })

  it('says so when there is no secret to sign a session with', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    const res = await POST(post({ token: TOKEN }))
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('GET and DELETE /api/admin/session', () => {
  it('reports whether the cookie it gave is still good', async () => {
    const cookie = (await POST(post({ token: TOKEN }))).headers.get('set-cookie') as string
    const pair = cookie.split(';')[0] as string

    const signedIn = await GET(
      new Request('http://localhost/api/admin/session', { headers: { cookie: pair } })
    )
    expect(await signedIn.json()).toEqual({ authenticated: true })

    const anonymous = await GET(new Request('http://localhost/api/admin/session'))
    expect(await anonymous.json()).toEqual({ authenticated: false })
  })

  it('expires the cookie on sign out', async () => {
    const res = await DELETE()
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i)
  })
})
