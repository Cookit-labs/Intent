import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/agents/history: a wallet's own agent races. The repo is faked so
 * what is under test is the route's own logic — validating the address,
 * rate-limiting first, and what it returns with no database — not the SQL,
 * which analytics.test.ts covers against the fake db.
 */

const ACCOUNT = Keypair.random().publicKey()

const historyForAccount = vi.fn()
vi.mock('../server/analytics', () => ({ getAnalyticsRepo: async () => ({ historyForAccount }) }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))

let configured = true
vi.mock('../server/db', () => ({ databaseConfigured: () => configured }))

beforeEach(() => {
  historyForAccount.mockReset()
  historyForAccount.mockResolvedValue({ entries: [], hasMore: false })
  configured = true
})

const get = (search: string): Request => new Request(`http://localhost/api/agents/history${search}`)

describe('GET /api/agents/history', () => {
  it('refuses a request with no account', async () => {
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(''))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_account' })
    expect(historyForAccount).not.toHaveBeenCalled()
  })

  it('refuses a request with a malformed account', async () => {
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get('?account=not-an-address'))
    expect(res.status).toBe(400)
  })

  it('reads a valid account, scoped to this deployment’s network', async () => {
    historyForAccount.mockResolvedValue({
      entries: [{ raceId: 'r1', reasoning: 'Filling now.' }],
      hasMore: false,
    })
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(`?account=${ACCOUNT}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entries: [{ raceId: 'r1', reasoning: 'Filling now.' }],
      hasMore: false,
    })
    expect(historyForAccount).toHaveBeenCalledWith(
      expect.objectContaining({ account: ACCOUNT, page: 1 })
    )
  })

  it('clamps an out-of-range page to a sane default', async () => {
    const { GET } = await import('../../app/api/agents/history/route')
    await GET(get(`?account=${ACCOUNT}&page=-5`))
    expect(historyForAccount).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }))
  })

  it('returns an empty page, not an error, with no database', async () => {
    configured = false
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(`?account=${ACCOUNT}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [], hasMore: false })
    expect(historyForAccount).not.toHaveBeenCalled()
  })

  it('returns an empty page, not an error, when the repo throws', async () => {
    historyForAccount.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const { GET } = await import('../../app/api/agents/history/route')
    const res = await GET(get(`?account=${ACCOUNT}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [], hasMore: false })
  })
})
