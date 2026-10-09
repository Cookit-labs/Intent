import { randomUUID } from 'node:crypto'

import { activeNetwork, type StellarNetworkName } from '@intent/config'

import { databaseConfigured, getPool, withTimeout, type QueryFn } from './db'
import { describeExecution, type ExecutionFlow } from './execution-flow'
import { reportError } from './report'

/**
 * What Intent records so its usage can be counted, and checked, later.
 *
 * Two small append-only logs, written as things happen and never changed:
 *
 *   usage_executions   one row per transaction a user submitted through the app
 *   agent_races  one row per agent competition, and one per agent in it
 *
 * They hold no emails and no text anyone typed or any model wrote. An execution
 * also carries what the signed transaction sold, read from its own bytes and
 * priced at the time (see execution-flow.ts), so volume can be counted. The hash
 * stays beside it, so any figure can be checked against the ledger by someone
 * who does not trust us.
 *
 * Writing is best effort and never in the way: a failure is reported and the
 * user's submit or race carries on exactly as if nothing had been recorded.
 *
 * The tables are created on first use, like the others here, because migration
 * files run only at first container init. Keep
 * packages/db/migrations/007_analytics.sql in sync.
 */

export const ANALYTICS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usage_executions (
    id            UUID        PRIMARY KEY,
    network       TEXT        NOT NULL,
    hash          TEXT,
    account       TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    fee_sponsored BOOLEAN     NOT NULL,
    ok            BOOLEAN     NOT NULL,
    failure       TEXT,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS usage_executions_hash_idx ON usage_executions (network, hash) WHERE hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS usage_executions_time_idx ON usage_executions (network, submitted_at)`,
  `CREATE INDEX IF NOT EXISTS usage_executions_account_idx ON usage_executions (network, account)`,
  `ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS asset_in TEXT`,
  `ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS asset_out TEXT`,
  `ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS amount_in NUMERIC`,
  `ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS volume_usd NUMERIC`,
  `CREATE TABLE IF NOT EXISTS intent_reads (
    id         UUID        PRIMARY KEY,
    network    TEXT        NOT NULL,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    understood BOOLEAN     NOT NULL,
    action     TEXT,
    token_in   TEXT,
    token_out  TEXT,
    size_usd   NUMERIC,
    reason     TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS intent_reads_time_idx ON intent_reads (network, read_at)`,
  `CREATE TABLE IF NOT EXISTS agent_races (
    id          UUID        PRIMARY KEY,
    network     TEXT        NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL,
    intent_type TEXT        NOT NULL,
    token_in    TEXT        NOT NULL,
    token_out   TEXT        NOT NULL,
    size_usd    NUMERIC,
    agents      INTEGER     NOT NULL,
    answered    INTEGER     NOT NULL,
    winner      TEXT,
    unanimous   BOOLEAN,
    outcome     TEXT        NOT NULL CHECK (outcome IN ('winner', 'no_winner', 'no_agent_answered')),
    duration_ms INTEGER     NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS agent_races_time_idx ON agent_races (network, started_at)`,
  `CREATE TABLE IF NOT EXISTS agent_proposals (
    race_id        UUID    NOT NULL REFERENCES agent_races (id),
    agent          TEXT    NOT NULL,
    model          TEXT,
    ok             BOOLEAN NOT NULL,
    failure        TEXT,
    latency_ms     INTEGER NOT NULL,
    score          NUMERIC,
    won            BOOLEAN NOT NULL,
    route_id       TEXT,
    execution_mode TEXT,
    PRIMARY KEY (race_id, agent)
  )`,
]

export type ExecutionKind = 'swap' | 'plan' | 'offer' | 'send' | 'lend' | 'offramp' | 'perp'

export interface ExecutionRecord {
  network: StellarNetworkName
  account: string
  kind: ExecutionKind
  feeSponsored: boolean
  ok: boolean
  /** Absent when the network refused the transaction before a hash existed. */
  hash?: string
  /** A fixed code, never an upstream message. */
  failure?: string
  /** What the transaction sold, when it could be read. */
  flow?: ExecutionFlow
  at?: Date
}

/** The parts of any submit route's result the log reads. */
export interface SubmitLike {
  ok: boolean
  hash?: string
  reason?: string
  code?: string
}

const CODE = /^[a-z][a-z0-9_]{0,39}$/

/**
 * A submit result as the log keeps it: whether it worked, the hash if there
 * is one, and a failure named by a short fixed code. Free text from an
 * upstream error is never copied across.
 */
export function executionFromResult<T extends SubmitLike>(
  result: T
): {
  ok: boolean
  hash?: string
  failure?: string
} {
  const hash = typeof result.hash === 'string' && result.hash !== '' ? { hash: result.hash } : {}
  if (result.ok) return { ok: true, ...hash }
  const named = result.reason ?? result.code
  const failure = typeof named === 'string' && CODE.test(named) ? named : 'unknown'
  return { ok: false, ...hash, failure }
}

/** Sorts an agent's error into a small fixed set, so no model output is stored. */
export function failureCode(error: unknown): string {
  const text = typeof error === 'string' ? error : ''
  if (/abort|time.?out|timed out/i.test(text)) return 'timeout'
  if (/429|rate.?limit|too many/i.test(text)) return 'rate_limited'
  if (/401|403|api.?key|unauthori[sz]ed|forbidden|auth/i.test(text)) return 'auth'
  if (/json|schema|invalid|malformed|parse/i.test(text)) return 'invalid_response'
  return 'error'
}

export interface RaceAttemptOk {
  agent: string
  model?: string
  ok: true
  latencyMs: number
  routeId?: string | undefined
  executionMode?: string | undefined
}

export interface RaceAttemptFailed {
  agent: string
  model?: string
  ok: false
  latencyMs: number
  error?: unknown
}

export interface RaceInput {
  id: string
  network: StellarNetworkName
  startedAt: Date
  durationMs: number
  intent: { type: string; tokenIn: string; tokenOut: string; sizeUsd: number | undefined }
  attempts: (RaceAttemptOk | RaceAttemptFailed)[]
  scores: Record<string, number>
  winner: string | null
  unanimous: boolean | null
}

export interface RaceRecord {
  id: string
  network: StellarNetworkName
  startedAt: Date
  intentType: string
  tokenIn: string
  tokenOut: string
  sizeUsd: number | null
  agents: number
  answered: number
  winner: string | null
  unanimous: boolean | null
  outcome: 'winner' | 'no_winner' | 'no_agent_answered'
  durationMs: number
  proposals: {
    agent: string
    model: string | null
    ok: boolean
    failure: string | null
    latencyMs: number
    score: number | null
    won: boolean
    routeId: string | null
    executionMode: string | null
  }[]
}

/** The race as it is stored: counted, classified, and stripped of anything anyone wrote. */
export function raceRecordFrom(input: RaceInput): RaceRecord {
  const answered = input.attempts.filter((a) => a.ok).length
  const outcome =
    answered === 0 ? 'no_agent_answered' : input.winner !== null ? 'winner' : 'no_winner'
  const size = input.intent.sizeUsd

  return {
    id: input.id,
    network: input.network,
    startedAt: input.startedAt,
    intentType: input.intent.type,
    tokenIn: input.intent.tokenIn,
    tokenOut: input.intent.tokenOut,
    sizeUsd: typeof size === 'number' && Number.isFinite(size) ? size : null,
    agents: input.attempts.length,
    answered,
    winner: input.winner,
    unanimous: input.unanimous,
    outcome,
    durationMs: input.durationMs,
    proposals: input.attempts.map((a) =>
      a.ok
        ? {
            agent: a.agent,
            model: a.model ?? null,
            ok: true,
            failure: null,
            latencyMs: a.latencyMs,
            score: input.scores[a.agent] ?? null,
            won: a.agent === input.winner,
            routeId: a.routeId ?? null,
            executionMode: a.executionMode ?? null,
          }
        : {
            agent: a.agent,
            model: a.model ?? null,
            ok: false,
            failure: failureCode(a.error),
            latencyMs: a.latencyMs,
            score: null,
            won: false,
            routeId: null,
            executionMode: null,
          }
    ),
  }
}

export interface IntentReadRecord {
  network: StellarNetworkName
  understood: boolean
  action?: string
  tokenIn?: string
  tokenOut?: string
  sizeUsd?: number
  /** A fixed code for a read that failed, never free text. */
  reason?: string
  at?: Date
}

export interface AnalyticsRepo {
  ensureSchema: () => Promise<void>
  recordIntentRead: (record: IntentReadRecord) => Promise<void>
  recordExecution: (record: ExecutionRecord) => Promise<void>
  recordRace: (record: RaceRecord) => Promise<void>
}

export function createAnalyticsRepo(query: QueryFn): AnalyticsRepo {
  return {
    async ensureSchema() {
      for (const statement of ANALYTICS_DDL) await query(statement)
    },

    async recordExecution(r) {
      // A hash is recorded once per network however often it is submitted.
      await query(
        `INSERT INTO usage_executions
           (id, network, hash, account, kind, fee_sponsored, ok, failure, submitted_at,
            asset_in, asset_out, amount_in, volume_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          r.network,
          r.hash ?? null,
          r.account,
          r.kind,
          r.feeSponsored,
          r.ok,
          r.failure ?? null,
          (r.at ?? new Date()).toISOString(),
          r.flow?.assetIn ?? null,
          r.flow?.assetOut ?? null,
          r.flow?.amountIn ?? null,
          r.flow?.volumeUsd ?? null,
        ]
      )
    },

    async recordIntentRead(r) {
      await query(
        `INSERT INTO intent_reads
           (id, network, read_at, understood, action, token_in, token_out, size_usd, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          r.network,
          (r.at ?? new Date()).toISOString(),
          r.understood,
          r.action ?? null,
          r.tokenIn ?? null,
          r.tokenOut ?? null,
          typeof r.sizeUsd === 'number' && Number.isFinite(r.sizeUsd) ? r.sizeUsd : null,
          r.reason ?? null,
        ]
      )
    },

    async recordRace(r) {
      await query(
        `INSERT INTO agent_races
           (id, network, started_at, intent_type, token_in, token_out, size_usd,
            agents, answered, winner, unanimous, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING`,
        [
          r.id,
          r.network,
          r.startedAt.toISOString(),
          r.intentType,
          r.tokenIn,
          r.tokenOut,
          r.sizeUsd,
          r.agents,
          r.answered,
          r.winner,
          r.unanimous,
          r.outcome,
          r.durationMs,
        ]
      )
      for (const p of r.proposals) {
        await query(
          `INSERT INTO agent_proposals
             (race_id, agent, model, ok, failure, latency_ms, score, won, route_id, execution_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [
            r.id,
            p.agent,
            p.model,
            p.ok,
            p.failure,
            p.latencyMs,
            p.score,
            p.won,
            p.routeId,
            p.executionMode,
          ]
        )
      }
    },
  }
}

const globalForAnalytics = globalThis as unknown as { intentAnalyticsSchema?: Promise<void> }

/** Every statement is bounded, so a database that hangs holds a request for this long and no more. */
const WRITE_TIMEOUT_MS = 1_500

/** The production repository, over the shared pool; the tables are created on first use. */
export async function getAnalyticsRepo(): Promise<AnalyticsRepo> {
  const pool = getPool()
  const repo = createAnalyticsRepo(async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), WRITE_TIMEOUT_MS)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForAnalytics.intentAnalyticsSchema === undefined) {
    globalForAnalytics.intentAnalyticsSchema = repo.ensureSchema().catch((e: unknown) => {
      // A failed attempt must not be cached as success.
      delete globalForAnalytics.intentAnalyticsSchema
      throw e
    })
  }
  await globalForAnalytics.intentAnalyticsSchema
  return repo
}

export interface LogExecutionInput {
  kind: ExecutionKind
  account: string
  feeSponsored: boolean
  result: SubmitLike
  /** The signed envelope that was sent, so what it moved can be recorded. */
  signedXdr?: string
}

/** What the transaction sold, or nothing: a failure to read it must never cost the row itself. */
async function readFlowSafely(input: LogExecutionInput): Promise<ExecutionFlow | undefined> {
  if (!input.result.ok || input.signedXdr === undefined) return undefined
  try {
    return await describeExecution(input.signedXdr)
  } catch (e) {
    reportError('analytics/flow', e, { kind: input.kind })
    return undefined
  }
}

/**
 * Records a submitted transaction. Never throws and never waits long: with no
 * database it does nothing, and any failure is reported and swallowed so the
 * user's transaction is unaffected.
 */
export async function logExecution(input: LogExecutionInput): Promise<void> {
  if (!databaseConfigured()) return
  try {
    const repo = await getAnalyticsRepo()
    const flow = await readFlowSafely(input)
    await repo.recordExecution({
      network: activeNetwork(),
      account: input.account,
      kind: input.kind,
      feeSponsored: input.feeSponsored,
      ...executionFromResult(input.result),
      ...(flow === undefined ? {} : { flow }),
    })
  } catch (e) {
    reportError('analytics/execution', e, { kind: input.kind })
  }
}

/**
 * Records how a typed instruction was read: the action, tokens and size the model
 * understood, or the fixed reason it did not. The sentence itself is never stored.
 */
export async function logIntentRead(input: Omit<IntentReadRecord, 'network'>): Promise<void> {
  if (!databaseConfigured()) return
  try {
    const repo = await getAnalyticsRepo()
    await repo.recordIntentRead({ network: activeNetwork(), ...input })
  } catch (e) {
    reportError('analytics/intent', e, { understood: input.understood })
  }
}

/** Records an agent race. Same promise as `logExecution`: best effort, never in the way. */
export async function logRace(input: RaceInput): Promise<void> {
  if (!databaseConfigured()) return
  try {
    const repo = await getAnalyticsRepo()
    await repo.recordRace(raceRecordFrom(input))
  } catch (e) {
    reportError('analytics/race', e, { network: input.network })
  }
}
