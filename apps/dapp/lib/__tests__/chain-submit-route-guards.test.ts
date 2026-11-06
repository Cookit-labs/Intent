import { afterEach, describe, expect, it, vi } from 'vitest'

import { guarded } from './solana-wallet-guards.fixture'
import {
  CAPTURE_ACCOUNT,
  JUPITER_SOL_TO_USDC,
} from '../chains/solana/__fixtures__/captured-transactions'

const state = vi.hoisted(() => ({ sent: [] as string[] }))

vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))
/** The real Solana module and checks, with only Jupiter's sending replaced. */
async function submit(signedTransaction: string): Promise<Response> {
  const { POST } = await import('../../app/api/chain/[chain]/submit/route')
  const { chainModule } = await import('../chains/registry')
  const jupiter = chainModule('solana')?.venues.find((v) => v.id === 'jupiter')
  if (jupiter === undefined) throw new Error('no jupiter venue')
  vi.spyOn(jupiter, 'submit').mockImplementation(async (input) => {
    if (input.signed.family === 'solana') state.sent.push(input.signed.signedTransaction)
    return { ok: true, txHash: 'sig' }
  })
  return POST(
    new Request('http://localhost/api/chain/solana/submit', {
      method: 'POST',
      body: JSON.stringify({
        account: CAPTURE_ACCOUNT,
        venueId: 'jupiter',
        signed: { family: 'solana', signedTransaction },
        context: { requestId: 'r' },
      }),
    }),
    { params: Promise.resolve({ chain: 'solana' }) }
  )
}

afterEach(() => {
  state.sent = []
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('the chain submit route and a wallet’s guard instructions', { timeout: 60_000 }, () => {
  it('sends a Jupiter swap Phantom guarded, exactly as the wallet signed it', async () => {
    const signed = guarded(JUPITER_SOL_TO_USDC, 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
    const res = await submit(signed)
    expect(res.status).toBe(200)
    expect(state.sent).toEqual([signed])
  })

  it('still refuses, and sends nothing, when anything else was added', async () => {
    const signed = guarded(JUPITER_SOL_TO_USDC, 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')
    const res = await submit(signed)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/Jupiter should not need/)
    expect(state.sent).toEqual([])
  })
})
