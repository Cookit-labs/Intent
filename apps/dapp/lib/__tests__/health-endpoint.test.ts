import { Keypair } from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkHealth, healthStatus, type HealthProbes } from '../server/health'

/**
 * The health endpoint: what a load balancer, an uptime monitor, or a person
 * with a browser tab asks before trusting a deployment.
 *
 * Composition is tested with injected probes, so nothing here touches a
 * database or the network. What is under test is the judgement: which
 * checks make the whole thing unhealthy (the database, Horizon, the RPC —
 * the app cannot serve without them) and which are reported but tolerated
 * (the sponsor: an empty or absent sponsor degrades fees, not the app). And
 * the discipline: every probe is bounded, so a hung upstream produces a 503
 * in three seconds rather than a request that never answers.
 */

const ok = async (): Promise<void> => undefined
const fails = (message: string) => async (): Promise<never> => {
  throw new Error(message)
}

const SPONSOR = 'G'.padEnd(56, 'S')

function probes(over: Partial<HealthProbes> = {}): HealthProbes {
  return {
    database: { configured: true, probe: ok },
    horizon: ok,
    rpc: ok,
    sponsor: {
      account: SPONSOR,
      balance: async () => ({ funded: true, balanceXlm: '41.5000000' }),
    },
    ...over,
  }
}

describe('checkHealth', () => {
  it('is ok when every probe passes, and says which network', async () => {
    const report = await checkHealth({ probes: probes(), network: 'testnet' })

    expect(report.ok).toBe(true)
    expect(report.network).toBe('testnet')
    expect(report.checks.database).toEqual({ ok: true, ms: expect.any(Number), configured: true })
    expect(report.checks.horizon).toEqual({ ok: true, ms: expect.any(Number) })
    expect(report.checks.rpc).toEqual({ ok: true, ms: expect.any(Number) })
    expect(report.checks.sponsor).toEqual({
      ok: true,
      ms: expect.any(Number),
      configured: true,
      funded: true,
      balanceXlm: '41.5000000',
      account: SPONSOR,
    })
  })

  it('is not ok when a required check fails, and carries the reason', async () => {
    const report = await checkHealth({
      probes: probes({
        database: { configured: true, probe: fails('connect ECONNREFUSED 127.0.0.1:5432') },
      }),
      network: 'testnet',
    })

    expect(report.ok).toBe(false)
    expect(report.checks.database).toEqual({
      ok: false,
      ms: expect.any(Number),
      configured: true,
      detail: 'connect ECONNREFUSED 127.0.0.1:5432',
    })
    expect(report.checks.horizon.ok).toBe(true)
  })

  it('says when no database is configured at all, and does not probe for one', async () => {
    // Configured-and-down is a blip a monitor should page about; not
    // configured is a deployment error, and the two must not read the same.
    // The sponsor refuses to sponsor without a ledger (see sponsor.test.ts),
    // so on a deploy with a key this is the line that explains why nothing
    // is being sponsored.
    const report = await checkHealth({
      probes: probes({ database: { configured: false, probe: fails('never called') } }),
      network: 'mainnet',
    })

    expect(report.ok).toBe(false)
    expect(report.checks.database).toEqual({
      ok: false,
      ms: 0,
      configured: false,
      detail: 'DATABASE_URL is not set',
    })
  })

  it('counts a probe that never answers as down after the timeout, and tells it to stop', async () => {
    let seen: AbortSignal | undefined
    const report = await checkHealth({
      probes: probes({
        rpc: (signal) => {
          seen = signal
          return new Promise(() => undefined)
        },
      }),
      network: 'testnet',
      timeoutMs: 20,
    })

    expect(report.ok).toBe(false)
    expect(report.checks.rpc.ok).toBe(false)
    expect(report.checks.rpc.detail).toBe('timed out after 20 ms')
    expect(seen?.aborted).toBe(true)
  })

  it('runs the probes together, not one after another', async () => {
    // Three probes at three seconds each would be nine seconds in series —
    // longer than most monitors wait, so the endpoint would fail on its own.
    // Each probe here waits for the others to have started: in series the
    // first would wait alone until the timeout; together they all release.
    let started = 0
    let release: () => void = () => undefined
    const everyoneStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const together = async (): Promise<void> => {
      started += 1
      if (started === 3) release()
      await everyoneStarted
    }

    const report = await checkHealth({
      probes: probes({
        database: { configured: true, probe: together },
        horizon: together,
        rpc: together,
      }),
      network: 'testnet',
      timeoutMs: 200,
    })

    expect(report.ok).toBe(true)
  })

  describe('the sponsor check', () => {
    it('is fine when no sponsor is configured, and names no account', async () => {
      const report = await checkHealth({
        probes: probes({ sponsor: { account: undefined, balance: fails('never called') } }),
        network: 'testnet',
      })

      expect(report.ok).toBe(true)
      expect(report.checks.sponsor).toEqual({
        ok: true,
        ms: 0,
        configured: false,
        funded: false,
      })
    })

    it('reports an unfunded sponsor without failing the endpoint', async () => {
      const report = await checkHealth({
        probes: probes({
          sponsor: { account: SPONSOR, balance: async () => ({ funded: false, balanceXlm: '0' }) },
        }),
        network: 'testnet',
      })

      expect(report.ok).toBe(true)
      expect(report.checks.sponsor).toEqual({
        ok: false,
        ms: expect.any(Number),
        configured: true,
        funded: false,
        balanceXlm: '0',
        account: SPONSOR,
      })
    })

    it('reports a balance that cannot be read without failing the endpoint', async () => {
      const report = await checkHealth({
        probes: probes({ sponsor: { account: SPONSOR, balance: fails('Horizon 503') } }),
        network: 'testnet',
      })

      expect(report.ok).toBe(true)
      expect(report.checks.sponsor).toEqual({
        ok: false,
        ms: expect.any(Number),
        configured: true,
        funded: false,
        account: SPONSOR,
        detail: 'Horizon 503',
      })
    })
  })
})

describe('healthStatus', () => {
  it('is 200 when ok and 503 otherwise', async () => {
    expect(healthStatus(await checkHealth({ probes: probes(), network: 'testnet' }))).toBe(200)
    expect(
      healthStatus(
        await checkHealth({ probes: probes({ horizon: fails('down') }), network: 'testnet' })
      )
    ).toBe(503)
  })
})

describe('GET /api/health', () => {
  const secret = Keypair.random().secret()

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['SPONSOR_SECRET_KEY']
    delete process.env['DATABASE_URL']
  })

  it('answers 503 JSON with no database and no network, and never reveals the sponsor secret', async () => {
    process.env['SPONSOR_SECRET_KEY'] = secret
    delete process.env['DATABASE_URL']
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    const { GET } = await import('../../app/api/health/route')

    const res = await GET()

    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text).not.toContain(secret)
    const body = JSON.parse(text) as Awaited<ReturnType<typeof checkHealth>>
    expect(body.ok).toBe(false)
    expect(body.network).toBe('testnet')
    expect(body.checks.database).toEqual({
      ok: false,
      ms: 0,
      configured: false,
      detail: 'DATABASE_URL is not set',
    })
    expect(body.checks.horizon).toEqual({ ok: false, ms: expect.any(Number), detail: 'offline' })
    expect(body.checks.rpc.ok).toBe(false)
    expect(body.checks.sponsor).toMatchObject({
      ok: false,
      configured: true,
      funded: false,
      account: Keypair.fromSecret(secret).publicKey(),
      detail: 'offline',
    })
  })
})
