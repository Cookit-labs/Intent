import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applySlippage } from '../swap/assets'
import { DEFAULT_SLIPPAGE_BPS } from '../swap/build-tx'

const built = vi.fn()

vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../swap/sources/soroswap-quoter', () => ({
  createSoroswapQuoter: () => ({
    quote: async () => ({
      ok: true,
      quote: {
        source: 'soroswap',
        kind: 'strict_send',
        from: { kind: 'native', code: 'XLM' },
        to: { kind: 'classic', code: 'USDC', issuer: 'GISSUER' },
        sendAmount: '100000000',
        destAmount: '1000000000',
        path: [],
        quotedAt: new Date().toISOString(),
      },
    }),
  }),
}))
vi.mock('../swap/build-soroban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../swap/build-soroban')>()
  return {
    ...actual,
    buildSorobanSwap: async (args: unknown) => {
      built(args)
      return { xdr: 'XDR', sendAmount: '100000000' }
    },
    // Stops the route right after the floor was chosen: that is the thing
    // under test, and the preview that follows needs a real simulation.
    prepareSorobanSwap: async () => ({ ok: false, reason: 'stopped here' }),
  }
})

const ACCOUNT = Keypair.random().publicKey()

function body(extra: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/swap/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT,
      quote: {
        source: 'soroswap',
        kind: 'strict_send',
        from: { kind: 'native', code: 'XLM' },
        to: { kind: 'classic', code: 'USDC', issuer: 'GISSUER' },
        sendAmount: '100000000',
        destAmount: '1000000000',
        path: [],
        quotedAt: new Date().toISOString(),
      },
      ...extra,
    }),
  })
}

async function post(request: Request) {
  const { POST } = await import('../../app/api/swap/build/route')
  return POST(request)
}

beforeEach(() => {
  built.mockClear()
})

describe('POST /api/swap/build, the floor on a Soroswap route', () => {
  it('uses the default tolerance when none was chosen', async () => {
    await post(body())
    expect(built.mock.calls[0]?.[0]).toMatchObject({
      minReceive: applySlippage('1000000000', DEFAULT_SLIPPAGE_BPS),
    })
  })

  it('uses the tolerance the user chose, so a tighter one is a higher floor', async () => {
    await post(body({ slippageBps: 10 }))
    const tight = (built.mock.calls[0]?.[0] as { minReceive: string }).minReceive
    expect(tight).toBe(applySlippage('1000000000', 10))

    built.mockClear()
    await post(body({ slippageBps: 300 }))
    const loose = (built.mock.calls[0]?.[0] as { minReceive: string }).minReceive
    expect(loose).toBe(applySlippage('1000000000', 300))
    expect(BigInt(tight)).toBeGreaterThan(BigInt(loose))
  })

  it('refuses a tolerance above the most the app allows, before building anything', async () => {
    const res = await post(body({ slippageBps: 5000 }))
    expect(res.status).toBe(400)
    expect(built).not.toHaveBeenCalled()
  })

  it('refuses a tolerance that is not a whole number of basis points', async () => {
    expect((await post(body({ slippageBps: 0.5 }))).status).toBe(400)
    expect((await post(body({ slippageBps: -1 }))).status).toBe(400)
    expect(built).not.toHaveBeenCalled()
  })
})
