import { beforeEach, describe, expect, it, vi } from 'vitest'

const addSignup = vi.fn()
const setStatus = vi.fn()

vi.mock('../server/db', () => ({
  addSignup: (...args: unknown[]) => addSignup(...args),
  setStatus: (...args: unknown[]) => setStatus(...args),
  listSignups: vi.fn(async () => []),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => undefined) }))

import { POST } from '../../app/api/admin/waitlist/route'

const TOKEN = 'a-sixteen-char-token'

function post(body: unknown, token: string = TOKEN): Request {
  return new Request('http://localhost/api/admin/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/waitlist', () => {
  beforeEach(() => {
    addSignup.mockReset()
    setStatus.mockReset()
    process.env['ADMIN_TOKEN'] = TOKEN
  })

  it('creates the row first when an email that never signed up is accepted', async () => {
    const res = await POST(post({ email: ' New@Example.com ', status: 'accepted' }))

    expect(res.status).toBe(200)
    expect(addSignup).toHaveBeenCalledWith('new@example.com', null)
    expect(setStatus).toHaveBeenCalledWith('new@example.com', 'accepted')
  })

  it('does not create rows when revoking or rejecting', async () => {
    await POST(post({ email: 'a@example.com', status: 'rejected' }))
    await POST(post({ email: 'a@example.com', status: 'pending' }))

    expect(addSignup).not.toHaveBeenCalled()
  })

  it('refuses a wrong token before touching the database', async () => {
    const res = await POST(
      post({ email: 'a@example.com', status: 'accepted' }, 'wrong-wrong-wrong-wrong')
    )

    expect(res.status).toBe(401)
    expect(addSignup).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })
})
