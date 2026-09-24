import { stellarTestnet } from '@intent/config'

import { readSponsorBalance, type SponsorBalance } from '../sponsor/balance'
import { sponsorAccount } from '../sponsor/sponsor'
import { getPool } from './db'

/**
 * What GET /api/health answers.
 *
 * Three checks the app cannot serve without — the database, Horizon, the
 * Soroban RPC — and one it can: the sponsor. A sponsor that is unfunded or
 * unreadable means users pay their own fees, which is the state the app was
 * in before sponsorship existed, so it is reported but does not turn the
 * endpoint red. The database, by contrast, is where sessions, rules and the
 * waitlist live; without it most routes answer 500.
 *
 * Every probe is bounded. A monitor that asks and never hears back marks the
 * deployment down anyway, and a hung upstream should produce a 503 with a
 * reason in three seconds, not a request that hangs with it. The probes run
 * together for the same reason: four sequential three-second waits would be
 * twelve, past what most monitors allow.
 *
 * Nothing here names a secret. The sponsor's public key is derived from the
 * configured secret by `sponsorAccount` and reported only when one is set —
 * it is on the ledger anyway, and GET /api/sponsor already says it.
 */

export interface Check {
  ok: boolean
  /** How long the probe took, or the timeout when it never answered. */
  ms: number
  /** Why it failed. Absent when ok. */
  detail?: string
}

export interface SponsorCheck extends Check {
  configured: boolean
  funded: boolean
  balanceXlm?: string
  /** The sponsor's public key. Present only when one is configured. */
  account?: string
}

export interface HealthReport {
  ok: boolean
  network: string
  checks: { database: Check; horizon: Check; rpc: Check; sponsor: SponsorCheck }
}

/** Resolves when the thing is up; throws with the reason when it is not. */
export type Probe = (signal: AbortSignal) => Promise<void>

export interface HealthProbes {
  database: Probe
  horizon: Probe
  rpc: Probe
  sponsor: {
    /** The public key, when a sponsor is configured. Never the secret. */
    account: string | undefined
    balance: (account: string, signal: AbortSignal) => Promise<SponsorBalance>
  }
}

export interface HealthOptions {
  probes: HealthProbes
  network: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3_000

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type Timed<T> = { ok: true; ms: number; value: T } | { ok: false; ms: number; detail: string }

/**
 * One probe under the timeout. The signal is aborted when time runs out so
 * a fetch behind it actually stops, rather than completing into the void
 * after the answer has gone out.
 */
async function timed<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<Timed<T>> {
  const controller = new AbortController()
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })

  try {
    const value = await Promise.race([run(controller.signal), timeout])
    return { ok: true, ms: Date.now() - started, value }
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: reason(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkOne(probe: Probe, timeoutMs: number): Promise<Check> {
  const r = await timed(probe, timeoutMs)
  return r.ok ? { ok: true, ms: r.ms } : { ok: false, ms: r.ms, detail: r.detail }
}

async function checkSponsor(
  sponsor: HealthProbes['sponsor'],
  timeoutMs: number
): Promise<SponsorCheck> {
  const { account } = sponsor
  if (account === undefined) return { ok: true, ms: 0, configured: false, funded: false }

  const r = await timed((signal) => sponsor.balance(account, signal), timeoutMs)
  if (!r.ok) {
    return { ok: false, ms: r.ms, configured: true, funded: false, account, detail: r.detail }
  }
  return {
    ok: r.value.funded,
    ms: r.ms,
    configured: true,
    funded: r.value.funded,
    balanceXlm: r.value.balanceXlm,
    account,
  }
}

export async function checkHealth(options: HealthOptions): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { probes } = options

  const [database, horizon, rpc, sponsor] = await Promise.all([
    checkOne(probes.database, timeoutMs),
    checkOne(probes.horizon, timeoutMs),
    checkOne(probes.rpc, timeoutMs),
    checkSponsor(probes.sponsor, timeoutMs),
  ])

  return {
    ok: database.ok && horizon.ok && rpc.ok,
    network: options.network,
    checks: { database, horizon, rpc, sponsor },
  }
}

export function healthStatus(report: HealthReport): 200 | 503 {
  return report.ok ? 200 : 503
}

type Env = Record<string, string | undefined>

/** The network this deployment is configured for. */
export function networkLabel(env: Env = process.env): string {
  return env['NEXT_PUBLIC_STELLAR_NETWORK'] ?? 'testnet'
}

export interface DefaultProbeOptions {
  fetchImpl?: typeof fetch
  env?: Env
}

/** The production probes: the shared pool, the configured Horizon and RPC, the configured sponsor. */
export function defaultProbes(options: DefaultProbeOptions = {}): HealthProbes {
  const doFetch = options.fetchImpl ?? fetch
  const env = options.env ?? process.env

  return {
    async database() {
      await getPool().query('SELECT 1')
    },

    async horizon(signal) {
      const res = await doFetch(`${stellarTestnet.horizonUrl}/`, {
        headers: { Accept: 'application/json' },
        signal,
      })
      if (!res.ok) throw new Error(`Horizon ${res.status}`)
    },

    async rpc(signal) {
      const res = await doFetch(stellarTestnet.sorobanRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal,
      })
      if (!res.ok) throw new Error(`RPC ${res.status}`)
      const body = (await res.json()) as { result?: { status?: string } }
      const status = body.result?.status
      if (status !== 'healthy') throw new Error(`RPC reports ${status ?? 'no status'}`)
    },

    sponsor: {
      account: sponsorAccount(env),
      balance: (account, signal) => readSponsorBalance(account, { fetchImpl: doFetch, signal }),
    },
  }
}
