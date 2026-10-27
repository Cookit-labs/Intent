import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/agents/health: Vercel Cron's actual invocation shape — a GET
 * request carrying `Authorization: Bearer <CRON_SECRET>` — not the POST and
 * custom header the older standing/tick route uses.
 */

const query = vi.fn()
vi.mock('../server/db', () => ({
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
  withTimeout: (p: Promise<unknown>) => p,
}))

const sendAlert = vi.fn()
vi.mock('../server/email', () => ({ getEmailSender: () => ({ sendAlert }) }))

const wasSent = vi.fn().mockResolvedValue(false)
const markSent = vi.fn()
vi.mock('../server/alerts', () => ({
  alertRecipient: () => 'ops@example.com',
  getAlertsRepo: async () => ({ wasSent, markSent }),
}))

const SECRET = 'a-secret-at-least-16-chars'

function get(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/agents/health', { headers })
}

beforeEach(() => {
  query.mockReset()
  sendAlert.mockReset()
  wasSent.mockReset().mockResolvedValue(false)
  markSent.mockReset()
  process.env['CRON_SECRET'] = SECRET
  // Healthy by default: plenty of races, everything answered.
  query.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('SELECT count(*) AS n')) {
      return { rows: [{ n: '10', asked: '40', answered: '40' }] }
    }
    return { rows: [{ agent: 'anthropic:claude-sonnet-5-5', races: '10', answered: '10' }] }
  })
})

describe('GET /api/agents/health', () => {
  it('refuses with no secret configured', async () => {
    delete process.env['CRON_SECRET']
    const { GET } = await import('../../app/api/agents/health/route')
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(503)
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a request with no Authorization header', async () => {
    const { GET } = await import('../../app/api/agents/health/route')
    const res = await GET(get())
    expect(res.status).toBe(403)
  })

  it('refuses the wrong secret', async () => {
    const { GET } = await import('../../app/api/agents/health/route')
    const res = await GET(get({ authorization: 'Bearer wrong' }))
    expect(res.status).toBe(403)
  })

  it("accepts Vercel's own Bearer format and returns the report", async () => {
    const { GET } = await import('../../app/api/agents/health/route')
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.severity).toBe('ok')
  })

  it('sends an alert on critical, and marks it sent', async () => {
    query.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('SELECT count(*) AS n')) {
        return { rows: [{ n: '10', asked: '10', answered: '0' }] }
      }
      return { rows: [] }
    })
    const { GET } = await import('../../app/api/agents/health/route')
    await GET(get({ authorization: `Bearer ${SECRET}` }))

    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(markSent).toHaveBeenCalledTimes(1)
  })

  it('does not alert twice in the same day', async () => {
    wasSent.mockResolvedValue(true)
    query.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('SELECT count(*) AS n')) {
        return { rows: [{ n: '10', asked: '10', answered: '0' }] }
      }
      return { rows: [] }
    })
    const { GET } = await import('../../app/api/agents/health/route')
    await GET(get({ authorization: `Bearer ${SECRET}` }))

    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('does not alert when the report is ok', async () => {
    const { GET } = await import('../../app/api/agents/health/route')
    await GET(get({ authorization: `Bearer ${SECRET}` }))
    expect(sendAlert).not.toHaveBeenCalled()
  })
})
