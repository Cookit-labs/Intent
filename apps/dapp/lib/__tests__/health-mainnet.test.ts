import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The health probes and the sponsor balance follow the network flag.
 *
 * Every other consumer moved to `stellarNetwork` when mainnet arrived; these
 * two still read testnet. On a mainnet deployment that made `GET /api/health`
 * report testnet Horizon and RPC under `network: 'mainnet'`, and the
 * low-balance alert — the one operator signal the sponsor has — read a
 * testnet account that has nothing to do with the funds paying real fees.
 *
 * Loaded once with the flag set, the way `sponsor-mainnet.test.ts` does: the
 * network is chosen at import.
 */

const ACCOUNT = 'G'.padEnd(56, 'A')

let health: typeof import('../server/health')
let balance: typeof import('../sponsor/balance')

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  vi.resetModules()
  health = await import('../server/health')
  balance = await import('../sponsor/balance')
  vi.unstubAllEnvs()
}, 60_000)

afterAll(() => {
  vi.resetModules()
})

/** Answers every request as a healthy upstream would, and remembers where it was sent. */
function recording(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ result: { status: 'healthy' } }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('on mainnet', () => {
  it('probes the public Horizon and RPC, not testnet', async () => {
    const calls: string[] = []
    const probes = health.defaultProbes({ fetchImpl: recording(calls), env: {} })
    const { signal } = new AbortController()

    await probes.horizon(signal)
    await probes.rpc(signal)

    expect(calls).toEqual(['https://horizon.stellar.org/', 'https://mainnet.sorobanrpc.com'])
  })

  it('reads the sponsor balance from the public Horizon', async () => {
    const calls: string[] = []

    await balance.readSponsorBalance(ACCOUNT, { fetchImpl: recording(calls) })

    expect(calls).toEqual([`https://horizon.stellar.org/accounts/${ACCOUNT}`])
  })
})
