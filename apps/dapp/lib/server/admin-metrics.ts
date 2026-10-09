import type { StellarNetworkName } from '@intent/config'

import { getAnalyticsRepo } from './analytics'
import { databaseConfigured, getPool, withTimeout, type QueryFn } from './db'

/**
 * The numbers the admin dashboard shows, read from the usage log.
 *
 * Every query is for one network and one date range, and takes both as
 * parameters: nothing here can add testnet to mainnet, because there is no
 * statement without a network in it.
 *
 * Definitions, fixed here so the page and any export agree:
 *   - a transaction counts only if the network accepted it;
 *   - headline volume is the dollar value of what the user sold or sent, for
 *     swaps, plans, offers and sends. Lending and cash-outs are reported as their
 *     own lines and are not added to it;
 *   - a transaction with no price is counted but marked unvalued, never guessed.
 */

export type RangeKey = '7d' | '30d' | '90d' | 'all'

export const RANGES: readonly RangeKey[] = ['7d', '30d', '90d', 'all']

export const HEADLINE_KINDS = ['swap', 'plan', 'offer', 'send'] as const

const DAY_MS = 86_400_000

export interface Scope {
  network: StellarNetworkName
  range: RangeKey
}

/** The first instant of a range, or null for all time. Whole days, in UTC. */
export function rangeStart(range: RangeKey, now: Date = new Date()): Date | null {
  if (range === 'all') return null
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(today - (days - 1) * DAY_MS)
}

export function isRange(value: unknown): value is RangeKey {
  return typeof value === 'string' && (RANGES as readonly string[]).includes(value)
}

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const maybe = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value)

const money = (value: unknown): number => Math.round(num(value) * 100) / 100

const day = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString().slice(0, 10)

export interface Overview {
  transactions: number
  failed: number
  successRate: number | null
  volumeUsd: number
  lendUsd: number
  unvalued: number
  wallets: number
  newWallets: number
  sponsored: number
  intents: number
  reads: { understood: number; unreadable: number }
}

export interface SeriesPoint {
  day: string
  transactions: number
  failed: number
  volumeUsd: number
  wallets: number
}

export interface KindRow {
  kind: string
  transactions: number
  failed: number
  volumeUsd: number
}

export interface PairRow {
  assetIn: string
  assetOut: string | null
  transactions: number
  volumeUsd: number
}

export interface WalletRow {
  account: string
  transactions: number
  volumeUsd: number
  firstSeen: string
  lastSeen: string
}

export interface TransactionRow {
  id: string
  hash: string | null
  account: string
  kind: string
  ok: boolean
  failure: string | null
  feeSponsored: boolean
  at: string
  assetIn: string | null
  assetOut: string | null
  amountIn: string | null
  volumeUsd: number | null
}

export interface TransactionFilter {
  kind?: string
  ok?: boolean
  sponsored?: boolean
  limit: number
  offset: number
}

export interface AgentRow {
  agent: string
  model: string | null
  races: number
  answered: number
  wins: number
  p50Ms: number | null
  p95Ms: number | null
}

export interface AgentsReport {
  races: number
  answerRate: number | null
  noAnswer: number
  unanimousRate: number | null
  p50Ms: number | null
  p95Ms: number | null
  agents: AgentRow[]
  failures: { reason: string; count: number }[]
}

export interface IntentsReport {
  byType: { type: string; count: number }[]
  rules: { status: string; count: number }[]
  reads: { understood: number; unreadable: number }
}

export interface WaitlistCounts {
  pending: number
  accepted: number
  rejected: number
}

export interface MetricsRepo {
  overview: (scope: Scope, now?: Date) => Promise<Overview>
  series: (scope: Scope, now?: Date) => Promise<SeriesPoint[]>
  byKind: (scope: Scope, now?: Date) => Promise<KindRow[]>
  pairs: (scope: Scope, now?: Date) => Promise<PairRow[]>
  wallets: (scope: Scope, now?: Date) => Promise<WalletRow[]>
  transactions: (
    scope: Scope,
    filter: TransactionFilter,
    now?: Date
  ) => Promise<{ total: number; rows: TransactionRow[] }>
  agents: (scope: Scope, now?: Date) => Promise<AgentsReport>
  intents: (scope: Scope, now?: Date) => Promise<IntentsReport>
  waitlist: () => Promise<WaitlistCounts>
}

/** Every day from the first to the last, so a quiet day is a zero and not a gap in the chart. */
function fillDays(rows: SeriesPoint[], from: Date | null, now: Date): SeriesPoint[] {
  const first = from ?? (rows[0] === undefined ? null : new Date(`${rows[0].day}T00:00:00Z`))
  if (first === null) return []
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out: SeriesPoint[] = []
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (let t = first.getTime(); t <= end; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10)
    out.push(byDay.get(key) ?? { day: key, transactions: 0, failed: 0, volumeUsd: 0, wallets: 0 })
  }
  return out
}

/** A table that was never created reads as empty: standing rules appear only once someone makes one. */
async function orEmpty(
  work: Promise<{ rows: Record<string, unknown>[] }>
): Promise<{ rows: Record<string, unknown>[] }> {
  try {
    return await work
  } catch (e) {
    if (e instanceof Error && /does not exist/.test(e.message)) return { rows: [] }
    throw e
  }
}

export function createMetricsRepo(query: QueryFn): MetricsRepo {
  const headline = [...HEADLINE_KINDS]
  const since = (s: Scope, now?: Date): string | null =>
    rangeStart(s.range, now)?.toISOString() ?? null

  return {
    async overview(scope, now) {
      const from = since(scope, now)
      const [exec, fresh, races, reads] = await Promise.all([
        query(
          `SELECT
             count(*) FILTER (WHERE ok)                                         AS txs,
             count(*) FILTER (WHERE NOT ok)                                     AS failed,
             coalesce(sum(volume_usd) FILTER (WHERE ok AND kind = ANY($3)), 0)  AS volume,
             coalesce(sum(volume_usd) FILTER (WHERE ok AND kind = 'lend'), 0)   AS lend,
             count(*) FILTER (WHERE ok AND kind = ANY($3) AND volume_usd IS NULL) AS unvalued,
             count(DISTINCT account) FILTER (WHERE ok)                          AS wallets,
             count(*) FILTER (WHERE ok AND fee_sponsored)                       AS sponsored
           FROM usage_executions
           WHERE network = $1 AND ($2::timestamptz IS NULL OR submitted_at >= $2)`,
          [scope.network, from, headline]
        ),
        query(
          `SELECT count(*) AS n FROM (
             SELECT account, min(submitted_at) AS first_seen
             FROM usage_executions WHERE network = $1 AND ok GROUP BY account
           ) f
           WHERE $2::timestamptz IS NULL OR f.first_seen >= $2`,
          [scope.network, from]
        ),
        query(
          `SELECT count(*) AS n FROM agent_races
           WHERE network = $1 AND ($2::timestamptz IS NULL OR started_at >= $2)`,
          [scope.network, from]
        ),
        query(
          `SELECT
             count(*) FILTER (WHERE understood)     AS understood,
             count(*) FILTER (WHERE NOT understood) AS unreadable
           FROM intent_reads
           WHERE network = $1 AND ($2::timestamptz IS NULL OR read_at >= $2)`,
          [scope.network, from]
        ),
      ])
      const e = exec.rows[0] ?? {}
      const transactions = num(e['txs'])
      const failed = num(e['failed'])
      return {
        transactions,
        failed,
        successRate: transactions + failed === 0 ? null : transactions / (transactions + failed),
        volumeUsd: money(e['volume']),
        lendUsd: money(e['lend']),
        unvalued: num(e['unvalued']),
        wallets: num(e['wallets']),
        newWallets: num(fresh.rows[0]?.['n']),
        sponsored: num(e['sponsored']),
        intents: num(races.rows[0]?.['n']),
        reads: {
          understood: num(reads.rows[0]?.['understood']),
          unreadable: num(reads.rows[0]?.['unreadable']),
        },
      }
    },

    async series(scope, now = new Date()) {
      const from = since(scope, now)
      const { rows } = await query(
        `SELECT date_trunc('day', submitted_at AT TIME ZONE 'UTC')                AS day,
                count(*) FILTER (WHERE ok)                                         AS txs,
                count(*) FILTER (WHERE NOT ok)                                     AS failed,
                coalesce(sum(volume_usd) FILTER (WHERE ok AND kind = ANY($3)), 0)  AS volume,
                count(DISTINCT account) FILTER (WHERE ok)                          AS wallets
         FROM usage_executions
         WHERE network = $1 AND ($2::timestamptz IS NULL OR submitted_at >= $2)
         GROUP BY 1 ORDER BY 1`,
        [scope.network, from, headline]
      )
      return fillDays(
        rows.map((r) => ({
          day: day(r['day']),
          transactions: num(r['txs']),
          failed: num(r['failed']),
          volumeUsd: money(r['volume']),
          wallets: num(r['wallets']),
        })),
        rangeStart(scope.range, now),
        now
      )
    },

    async byKind(scope, now) {
      const { rows } = await query(
        `SELECT kind,
                count(*) FILTER (WHERE ok)                      AS txs,
                count(*) FILTER (WHERE NOT ok)                  AS failed,
                coalesce(sum(volume_usd) FILTER (WHERE ok), 0)  AS volume
         FROM usage_executions
         WHERE network = $1 AND ($2::timestamptz IS NULL OR submitted_at >= $2)
         GROUP BY kind ORDER BY volume DESC, txs DESC`,
        [scope.network, since(scope, now)]
      )
      return rows.map((r) => ({
        kind: String(r['kind']),
        transactions: num(r['txs']),
        failed: num(r['failed']),
        volumeUsd: money(r['volume']),
      }))
    },

    async pairs(scope, now) {
      const { rows } = await query(
        `SELECT asset_in, asset_out, count(*) AS txs, coalesce(sum(volume_usd), 0) AS volume
         FROM usage_executions
         WHERE network = $1 AND ok AND asset_in IS NOT NULL AND kind = ANY($3)
           AND ($2::timestamptz IS NULL OR submitted_at >= $2)
         GROUP BY asset_in, asset_out ORDER BY volume DESC, txs DESC LIMIT 8`,
        [scope.network, since(scope, now), headline]
      )
      return rows.map((r) => ({
        assetIn: String(r['asset_in']),
        assetOut: r['asset_out'] === null ? null : String(r['asset_out']),
        transactions: num(r['txs']),
        volumeUsd: money(r['volume']),
      }))
    },

    async wallets(scope, now) {
      const { rows } = await query(
        `SELECT account, count(*) AS txs, coalesce(sum(volume_usd), 0) AS volume,
                min(submitted_at) AS first_seen, max(submitted_at) AS last_seen
         FROM usage_executions
         WHERE network = $1 AND ok AND ($2::timestamptz IS NULL OR submitted_at >= $2)
         GROUP BY account ORDER BY volume DESC, txs DESC, account LIMIT 10`,
        [scope.network, since(scope, now)]
      )
      return rows.map((r) => ({
        account: String(r['account']),
        transactions: num(r['txs']),
        volumeUsd: money(r['volume']),
        firstSeen: new Date(String(r['first_seen'])).toISOString(),
        lastSeen: new Date(String(r['last_seen'])).toISOString(),
      }))
    },

    async transactions(scope, filter, now) {
      const params = [
        scope.network,
        since(scope, now),
        filter.kind ?? null,
        filter.ok ?? null,
        filter.sponsored ?? null,
      ]
      const where = `network = $1 AND ($2::timestamptz IS NULL OR submitted_at >= $2)
         AND ($3::text IS NULL OR kind = $3)
         AND ($4::boolean IS NULL OR ok = $4)
         AND ($5::boolean IS NULL OR fee_sponsored = $5)`
      const [count, page] = await Promise.all([
        query(`SELECT count(*) AS n FROM usage_executions WHERE ${where}`, params),
        query(
          `SELECT id, hash, account, kind, ok, failure, fee_sponsored, submitted_at,
                  asset_in, asset_out, amount_in, volume_usd
           FROM usage_executions WHERE ${where}
           ORDER BY submitted_at DESC, id LIMIT $6 OFFSET $7`,
          [...params, filter.limit, filter.offset]
        ),
      ])
      return {
        total: num(count.rows[0]?.['n']),
        rows: page.rows.map((r) => ({
          id: String(r['id']),
          hash: r['hash'] === null ? null : String(r['hash']),
          account: String(r['account']),
          kind: String(r['kind']),
          ok: r['ok'] === true,
          failure: r['failure'] === null ? null : String(r['failure']),
          feeSponsored: r['fee_sponsored'] === true,
          at: new Date(String(r['submitted_at'])).toISOString(),
          assetIn: r['asset_in'] === null ? null : String(r['asset_in']),
          assetOut: r['asset_out'] === null ? null : String(r['asset_out']),
          amountIn: r['amount_in'] === null ? null : String(r['amount_in']),
          volumeUsd: r['volume_usd'] === null ? null : money(r['volume_usd']),
        })),
      }
    },

    async agents(scope, now) {
      const params = [scope.network, since(scope, now)]
      const range = `r.network = $1 AND ($2::timestamptz IS NULL OR r.started_at >= $2)`
      const [summary, agents, failures] = await Promise.all([
        query(
          `SELECT count(*) AS races,
                  coalesce(sum(answered), 0) AS answered, coalesce(sum(agents), 0) AS asked,
                  count(*) FILTER (WHERE outcome = 'no_agent_answered') AS no_answer,
                  count(*) FILTER (WHERE unanimous) AS unanimous,
                  count(*) FILTER (WHERE unanimous IS NOT NULL) AS judged,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
           FROM agent_races r WHERE ${range}`,
          params
        ),
        query(
          `SELECT p.agent, max(p.model) AS model, count(*) AS races,
                  count(*) FILTER (WHERE p.ok) AS answered,
                  count(*) FILTER (WHERE p.won) AS wins,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY p.latency_ms) FILTER (WHERE p.ok) AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY p.latency_ms) FILTER (WHERE p.ok) AS p95
           FROM agent_proposals p JOIN agent_races r ON r.id = p.race_id
           WHERE ${range} GROUP BY p.agent ORDER BY races DESC, p.agent`,
          params
        ),
        query(
          `SELECT coalesce(p.failure, 'unknown') AS reason, count(*) AS n
           FROM agent_proposals p JOIN agent_races r ON r.id = p.race_id
           WHERE ${range} AND NOT p.ok GROUP BY 1 ORDER BY n DESC`,
          params
        ),
      ])
      const s = summary.rows[0] ?? {}
      const asked = num(s['asked'])
      const judged = num(s['judged'])
      const round = (v: unknown): number | null => (maybe(v) === null ? null : Math.round(num(v)))
      return {
        races: num(s['races']),
        answerRate: asked === 0 ? null : num(s['answered']) / asked,
        noAnswer: num(s['no_answer']),
        unanimousRate: judged === 0 ? null : num(s['unanimous']) / judged,
        p50Ms: round(s['p50']),
        p95Ms: round(s['p95']),
        agents: agents.rows.map((r) => ({
          agent: String(r['agent']),
          model: r['model'] === null ? null : String(r['model']),
          races: num(r['races']),
          answered: num(r['answered']),
          wins: num(r['wins']),
          p50Ms: round(r['p50']),
          p95Ms: round(r['p95']),
        })),
        failures: failures.rows.map((r) => ({ reason: String(r['reason']), count: num(r['n']) })),
      }
    },

    async intents(scope, now) {
      const from = since(scope, now)
      const [types, rules, reads] = await Promise.all([
        query(
          `SELECT intent_type AS type, count(*) AS n FROM agent_races
           WHERE network = $1 AND ($2::timestamptz IS NULL OR started_at >= $2)
           GROUP BY 1 ORDER BY n DESC`,
          [scope.network, from]
        ),
        orEmpty(
          query(
            `SELECT status, count(*) AS n FROM standing_rules
             WHERE network = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
             GROUP BY 1 ORDER BY n DESC`,
            [scope.network, from]
          )
        ),
        query(
          `SELECT count(*) FILTER (WHERE understood) AS understood,
                  count(*) FILTER (WHERE NOT understood) AS unreadable
           FROM intent_reads
           WHERE network = $1 AND ($2::timestamptz IS NULL OR read_at >= $2)`,
          [scope.network, from]
        ),
      ])
      return {
        byType: types.rows.map((r) => ({ type: String(r['type']), count: num(r['n']) })),
        rules: rules.rows.map((r) => ({ status: String(r['status']), count: num(r['n']) })),
        reads: {
          understood: num(reads.rows[0]?.['understood']),
          unreadable: num(reads.rows[0]?.['unreadable']),
        },
      }
    },

    async waitlist() {
      const { rows } = await query(
        `SELECT status, count(*) AS n FROM waitlist_signups GROUP BY status`
      )
      const counts: WaitlistCounts = { pending: 0, accepted: 0, rejected: 0 }
      for (const r of rows) {
        const status = String(r['status'])
        if (status === 'pending' || status === 'accepted' || status === 'rejected') {
          counts[status] = num(r['n'])
        }
      }
      return counts
    },
  }
}

const QUERY_TIMEOUT_MS = 8_000

/** The production repository over the shared pool, with a bound on every statement. */
export async function getMetricsRepo(): Promise<MetricsRepo | undefined> {
  if (!databaseConfigured()) return undefined
  // The log's tables are made on first use; make sure they are there before reading them.
  await getAnalyticsRepo()
  const pool = getPool()
  return createMetricsRepo(async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), QUERY_TIMEOUT_MS)
    return { rows: result.rows as Record<string, unknown>[] }
  })
}
