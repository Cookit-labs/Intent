import { Keypair } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedRecipient } from '../names/resolve'
import type { MarketPrice } from '../swap/price-types'

/**
 * The mainnet trade cap at the routes, where a client's figures arrive.
 *
 * The cap is checked against what the deployment will actually spend — the
 * re-quoted amount, or the ceiling a fixed-output swap is widened to — and
 * never against the number the browser sent. A quote that claims to spend
 * "1" while asking for a large delivery is the case that matters: the
 * client's send figure is a statement of intent, and the cap must read the
 * fresh quote instead.
 */

const asOf = '2026-09-24T00:00:00.000Z'
const table: Record<string, MarketPrice> = {
  XLM: { symbol: 'XLM', usd: 0.2, source: 'reflector', asOf },
  USDC: { symbol: 'USDC', usd: 1, source: 'stellar-mainnet', asOf },
}

vi.mock('../swap/prices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../swap/prices')>()),
  fetchMarketPrices: () => Promise.resolve(table),
}))

const resolve = vi.fn<(input: string) => Promise<ResolvedRecipient>>()
vi.mock('../names/resolve', () => ({
  resolveRecipient: (input: string) => resolve(input),
}))

const ME = Keypair.random().publicKey()
const THEM = Keypair.random().publicKey()
const USDC = { kind: 'classic' as const, code: 'USDC', issuer: Keypair.random().publicKey() }
const XLM = { kind: 'classic' as const, code: 'XLM' }

/** Horizon that prices every path at 5 XLM per USDC and knows every account. */
function horizon(calls: string[]): typeof fetch {
  return ((url: string) => {
    calls.push(url)
    const u = new URL(url)
    if (u.pathname.endsWith('/paths/strict-send')) {
      const usdc = u.searchParams.get('source_amount') ?? '0'
      const xlm = (Number(usdc) * 5).toFixed(7)
      return json({
        _embedded: { records: [{ source_amount: usdc, destination_amount: xlm, path: [] }] },
      })
    }
    if (u.pathname.endsWith('/paths/strict-receive')) {
      const xlm = u.searchParams.get('destination_amount') ?? '0'
      const usdc = (Number(xlm) / 5).toFixed(7)
      return json({
        _embedded: { records: [{ source_amount: usdc, destination_amount: xlm, path: [] }] },
      })
    }
    if (u.pathname.includes('/accounts/')) {
      return json({ id: ME, sequence: '4578890000000001', balances: [] })
    }
    return Promise.resolve(new Response('{}', { status: 500 }))
  }) as unknown as typeof fetch
}

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  )
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let calls: string[]

beforeEach(() => {
  calls = []
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  vi.stubGlobal('fetch', horizon(calls))
  resolve.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('POST /api/swap/build on mainnet', () => {
  it('refuses a fixed-input swap over the cap, on the re-quoted amount', async () => {
    const { POST } = await import('../../app/api/swap/build/route')
    const res = await POST(
      post('/api/swap/build', {
        account: ME,
        quote: {
          source: 'horizon',
          kind: 'strict_send',
          from: USDC,
          to: XLM,
          sendAmount: '600000000',
          destAmount: '3000000000',
          path: [],
          quotedAt: new Date().toISOString(),
        },
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/caps each trade at \$50/)
    expect(body.error).toMatch(/\$60\.00/)
  })

  it('refuses a fixed-output swap by its ceiling, not by the send figure the client claims', async () => {
    const { POST } = await import('../../app/api/swap/build/route')
    const res = await POST(
      post('/api/swap/build', {
        account: ME,
        quote: {
          source: 'horizon',
          kind: 'strict_receive',
          from: USDC,
          to: XLM,
          // "I will spend 1 stroop" — for 300 XLM, which costs 60 USDC.
          sendAmount: '1',
          destAmount: '3000000000',
          path: [],
          quotedAt: new Date().toISOString(),
        },
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/caps each trade at \$50/)
    // The ceiling: 60 USDC widened by the default tolerance.
    expect(body.error).toMatch(/\$60\.3/)
    // Refused before any account was loaded to build against.
    expect(calls.some((u) => u.includes('/accounts/'))).toBe(false)
  })
})

describe('POST /api/plan/build on mainnet', () => {
  it('refuses a plan with a step over the cap', async () => {
    const { POST } = await import('../../app/api/plan/build/route')
    const res = await POST(
      post('/api/plan/build', {
        account: ME,
        actions: [{ kind: 'swap', from: USDC, to: XLM, sendAmount: '600000000', minReceive: '1' }],
      })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/caps each trade at \$50/)
  })

  it('builds a plan whose steps are under the cap', async () => {
    const { POST } = await import('../../app/api/plan/build/route')
    const res = await POST(
      post('/api/plan/build', {
        account: ME,
        actions: [{ kind: 'swap', from: USDC, to: XLM, sendAmount: '100000000', minReceive: '1' }],
      })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { xdr?: string }).xdr).toBeTypeOf('string')
  })
})

describe('POST /api/send/build on mainnet', () => {
  it('values the asset by its canonical code, however the client spelled it', async () => {
    resolve.mockResolvedValue({
      input: 'deon.xlm',
      kind: 'soroban-domain',
      address: THEM,
      resolvedOn: 'stellar-mainnet',
    })
    const { POST } = await import('../../app/api/send/build/route')
    const res = await POST(
      post('/api/send/build', { account: ME, asset: 'xlm', amount: '1000', recipient: 'deon.xlm' })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/caps each trade at \$50/)
    expect(body.error).not.toMatch(/could not be valued/)
  })
})
