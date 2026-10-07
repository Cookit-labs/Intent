import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Every route that submits a transaction records it. The structural test is
 * the one that matters over time: a submit route added later and not logged
 * would leave a hole in the numbers, and nothing else would notice.
 */

const APP_API = join(__dirname, '..', '..', 'app', 'api')

function submitRoutes(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...submitRoutes(full))
    else if (name === 'route.ts' && dir.endsWith(`${join('submit')}`)) out.push(full)
  }
  return out
}

describe('every submit route', () => {
  const routes = submitRoutes(APP_API)

  it('is found', () => {
    expect(routes.length).toBeGreaterThanOrEqual(8)
  })

  it.each(routes.map((r) => [r.slice(APP_API.length + 1).replace(/\\/g, '/'), r]))(
    '%s records the submit',
    (_name, path) => {
      const source = readFileSync(path as string, 'utf8')
      expect(source).toMatch(/logExecution\(/)
      expect(source).toMatch(/lib\/server\/analytics/)
    }
  )
})

const logged = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('../server/analytics', () => ({
  logExecution: async (input: unknown) => {
    logged.calls.push(input)
  },
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../swap/venue-routing', () => ({ assertSelfSubmission: () => undefined }))
vi.mock('../sponsor/sponsor-request', () => ({
  sponsorForRequest: async (_req: Request, xdr: string) => ({ xdr, sponsored: true }),
}))
vi.mock('../swap/submit', () => ({
  submitSignedSwap: async () => ({
    ok: true,
    hash: 'h'.repeat(64),
    ledger: 7,
    explorerUrl: 'https://x.test/tx/h',
  }),
}))

afterEach(() => {
  logged.calls = []
})

describe('swap/submit', () => {
  const post = (body: unknown): Request =>
    new Request('http://localhost/api/swap/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    })

  it('records the swap with the wallet, the sponsorship and the result, and answers as before', async () => {
    const { POST } = await import('../../app/api/swap/submit/route')
    const res = await POST(post({ signedXdr: 'AAAA', account: 'GACCOUNT' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, hash: 'h'.repeat(64), feeSponsored: true })
    expect(logged.calls).toEqual([
      {
        kind: 'swap',
        account: 'GACCOUNT',
        feeSponsored: true,
        result: expect.objectContaining({ ok: true, hash: 'h'.repeat(64) }),
      },
    ])
  })

  it('records nothing for a request refused before it was submitted', async () => {
    const { POST } = await import('../../app/api/swap/submit/route')
    const res = await POST(post({ account: 'GACCOUNT' }))
    expect(res.status).toBe(400)
    expect(logged.calls).toEqual([])
  })
})
