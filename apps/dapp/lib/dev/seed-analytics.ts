import { createHash } from 'node:crypto'

/**
 * Made-up usage for looking at the admin dashboard with something on it.
 *
 * Every row's id starts with SEED_PREFIX, a valid hex group no real id will ever
 * begin with, so the rows can be told apart and removed with one statement. The
 * generator is pure and seeded: the same inputs give the same rows.
 */

export const SEED_PREFIX = '5eed0000-'

export interface SeedOptions {
  network: 'testnet' | 'mainnet'
  days: number
  now: Date
  seed?: number
}

export interface SeedExecution {
  id: string
  network: string
  hash: string
  account: string
  kind: string
  feeSponsored: boolean
  ok: boolean
  failure: string | null
  at: Date
  assetIn: string | null
  assetOut: string | null
  amountIn: string | null
  volumeUsd: number | null
}

export interface SeedRace {
  id: string
  network: string
  at: Date
  intentType: string
  sizeUsd: number
  agents: number
  answered: number
  winner: string | null
  unanimous: boolean | null
  outcome: string
  durationMs: number
  proposals: {
    agent: string
    ok: boolean
    failure: string | null
    latencyMs: number
    score: number | null
    won: boolean
  }[]
}

export interface SeedRead {
  id: string
  network: string
  at: Date
  understood: boolean
  action: string | null
  tokenIn: string | null
  tokenOut: string | null
  sizeUsd: number | null
  reason: string | null
}

export interface Seed {
  executions: SeedExecution[]
  races: SeedRace[]
  reads: SeedRead[]
}

/** A small seeded generator, so a run can be repeated exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AGENTS = ['halcyon', 'vesper', 'argus', 'meridian']
const FAILURES = ['underfunded', 'slippage_exceeded', 'tx_bad_seq', 'timeout']
const AGENT_FAILURES = ['timeout', 'rate_limited', 'invalid_response', 'error']
const PRICE: Record<string, number> = { XLM: 0.2, USDC: 1, CETES: 0.06 }

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T
}

function weighted<T>(r: () => number, items: readonly [T, number][]): T {
  const total = items.reduce((n, [, w]) => n + w, 0)
  let at = r() * total
  for (const [item, w] of items) {
    at -= w
    if (at < 0) return item
  }
  return items[0]?.[0] as T
}

function hex(r: () => number, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += Math.floor(r() * 16).toString(16)
  return out
}

function seedId(r: () => number): string {
  return `${SEED_PREFIX}${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`
}

function account(index: number): string {
  const tail = String(index).padStart(5, '0')
  return `GSEED${'A'.repeat(46)}${tail}`
}

export function buildSeed(options: SeedOptions): Seed {
  const r = rng(options.seed ?? 20261009)
  const wallets = Array.from({ length: 24 }, (_, i) => account(i + 1))
  const end = options.now.getTime()
  const executions: SeedExecution[] = []
  const races: SeedRace[] = []
  const reads: SeedRead[] = []

  for (let d = options.days - 1; d >= 0; d--) {
    const dayStart = Date.UTC(
      options.now.getUTCFullYear(),
      options.now.getUTCMonth(),
      options.now.getUTCDate() - d
    )
    const growth = 1 + (options.days - d) / options.days
    const at = (): Date => new Date(Math.min(dayStart + Math.floor(r() * 86_400_000), end))

    const count = Math.floor(r() * 7 * growth)
    for (let i = 0; i < count; i++) {
      const kind = weighted(r, [
        ['swap', 60],
        ['offer', 15],
        ['send', 10],
        ['lend', 10],
        ['offramp', 5],
      ])
      const ok = r() < 0.92
      const flip = r() < 0.3
      const assetIn = flip ? 'USDC' : 'XLM'
      const assetOut = kind === 'send' || kind === 'lend' ? null : flip ? 'XLM' : 'USDC'
      const amount = Math.round((0.5 + r() * r() * 40) * 100) / 100
      const usd = r() < 0.04 ? null : Math.round(amount * (PRICE[assetIn] as number) * 100) / 100
      executions.push({
        id: seedId(r),
        network: options.network,
        hash: createHash('sha256').update(`seed-${d}-${i}-${options.network}`).digest('hex'),
        account: pick(r, wallets.slice(0, 6 + Math.floor((options.days - d) / 4))),
        kind,
        feeSponsored: r() < 0.4,
        ok,
        failure: ok ? null : pick(r, FAILURES),
        at: at(),
        assetIn: ok ? assetIn : null,
        assetOut: ok ? assetOut : null,
        amountIn: ok ? amount.toFixed(7) : null,
        volumeUsd: ok ? usd : null,
      })
    }

    for (let i = 0; i < 2; i++) {
      const proposals = AGENTS.map((agent) => {
        const ok = r() < 0.85
        return {
          agent,
          ok,
          failure: ok ? null : pick(r, AGENT_FAILURES),
          latencyMs: Math.floor(ok ? 500 + r() * 2500 : 3000 + r() * 4000),
          score: ok ? Math.round(60 + r() * 40) : null,
          won: false,
        }
      })
      const answered = proposals.filter((p) => p.ok)
      const best = answered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
      if (best !== undefined) best.won = true
      races.push({
        id: seedId(r),
        network: options.network,
        at: at(),
        intentType: weighted(r, [
          ['swap', 70],
          ['limit', 20],
          ['supply', 10],
        ]),
        sizeUsd: Math.round((1 + r() * 30) * 100) / 100,
        agents: proposals.length,
        answered: answered.length,
        winner: best?.agent ?? null,
        unanimous: answered.length === 0 ? null : r() < 0.55,
        outcome: answered.length === 0 ? 'no_agent_answered' : 'winner',
        durationMs: Math.floor(1500 + r() * 4000),
        proposals,
      })
    }

    for (let i = 0; i < 3; i++) {
      const understood = r() < 0.85
      reads.push({
        id: seedId(r),
        network: options.network,
        at: at(),
        understood,
        action: understood
          ? weighted(r, [
              ['swap', 80],
              ['supply', 12],
              ['borrow', 8],
            ])
          : null,
        tokenIn: understood ? 'XLM' : null,
        tokenOut: understood ? 'USDC' : null,
        sizeUsd: understood ? Math.round((1 + r() * 20) * 100) / 100 : null,
        reason: understood ? null : 'unreadable',
      })
    }
  }

  return { executions, races, reads }
}
