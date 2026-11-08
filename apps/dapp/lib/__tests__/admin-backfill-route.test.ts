import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ batches: 0 }))

vi.mock('../server/db', () => ({
  databaseConfigured: () => true,
  getPool: () => ({ query: async () => ({ rows: [] }) }),
  withTimeout: <T>(p: Promise<T>) => p,
}))
vi.mock('../server/analytics', () => ({ getAnalyticsRepo: async () => ({}) }))
vi.mock('../server/report', () => ({ reportError: vi.fn() }))
vi.mock('../server/backfill-values', () => ({
  remainingToValue: async () => 4,
  backfillBatch: async () => {
    state.batches += 1
    return { looked: 4, valued: 3, unreadable: 1, retry: 0, remaining: 0 }
  },
}))

import { GET, POST } from '../../app/api/admin/backfill/route'

const TOKEN = 'an-admin-token-of-length'
const req = (method: string, headers: Record<string, string> = { 'x-admin-token': TOKEN }) =>
  new Request('http://localhost/api/admin/backfill', { method, headers })

beforeEach(() => {
  state.batches = 0
  vi.stubEnv('ADMIN_TOKEN', TOKEN)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(40))
})

afterEach(() => vi.unstubAllEnvs())

describe('/api/admin/backfill', () => {
  it('refuses anyone who is not the admin, before reading or looking anything up', async () => {
    expect((await GET(req('GET', {}))).status).toBe(401)
    expect((await POST(req('POST', { 'x-admin-token': 'nope-nope-nope-nope' }))).status).toBe(401)
    expect(state.batches).toBe(0)
  })

  it('says how many are left, and runs one batch per call', async () => {
    expect(await (await GET(req('GET'))).json()).toEqual({ remaining: 4 })
    expect(await (await POST(req('POST'))).json()).toMatchObject({ valued: 3, remaining: 0 })
    expect(state.batches).toBe(1)
  })
})
