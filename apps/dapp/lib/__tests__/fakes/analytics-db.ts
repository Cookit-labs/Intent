import type { QueryFn } from '../../server/db'

/**
 * An in-memory stand-in for Postgres, for the analytics log.
 *
 * Answers the statements the log issues, matched by shape, and throws on
 * anything else, so a new query cannot pass by returning nothing. Setting
 * `down` makes every statement reject. Uniqueness is enforced the way the real
 * indexes do: one execution per (network, hash) when there is a hash.
 */

export interface FakeExecution {
  id: string
  network: string
  hash: string | null
  account: string
  kind: string
  fee_sponsored: boolean
  ok: boolean
  failure: string | null
  submitted_at: string
  asset_in: string | null
  asset_out: string | null
  amount_in: string | null
  volume_usd: number | null
  race_id: string | null
}

export interface FakeIntentRead {
  id: string
  network: string
  read_at: string
  understood: boolean
  action: string | null
  token_in: string | null
  token_out: string | null
  size_usd: number | null
  reason: string | null
}

export interface FakeRace {
  id: string
  network: string
  started_at: string
  intent_type: string
  token_in: string
  token_out: string
  size_usd: number | null
  agents: number
  answered: number
  winner: string | null
  unanimous: boolean | null
  outcome: string
  duration_ms: number
}

export interface FakeProposal {
  race_id: string
  agent: string
  model: string | null
  ok: boolean
  failure: string | null
  latency_ms: number
  score: number | null
  won: boolean
  route_id: string | null
  execution_mode: string | null
  reasoning: string | null
}

export interface FakeAnalyticsDb {
  query: QueryFn
  executions: FakeExecution[]
  races: FakeRace[]
  intentReads: FakeIntentRead[]
  proposals: FakeProposal[]
  log: string[]
  down?: Error
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function fakeAnalyticsDb(): FakeAnalyticsDb {
  const executions: FakeExecution[] = []
  const races: FakeRace[] = []
  const intentReads: FakeIntentRead[] = []
  const proposals: FakeProposal[] = []
  const log: string[] = []

  const db: FakeAnalyticsDb = {
    executions,
    races,
    intentReads,
    proposals,
    log,
    query: async (rawSql, params = []) => {
      const sql = normalise(rawSql)
      log.push(sql)
      if (db.down !== undefined) throw db.down
      const p = params as unknown[]

      if (
        sql.startsWith('CREATE TABLE') ||
        sql.startsWith('CREATE INDEX') ||
        sql.startsWith('CREATE UNIQUE INDEX') ||
        sql.startsWith('ALTER TABLE')
      ) {
        return { rows: [] }
      }

      const matchRace = (id: string | null, network: string, at: string): string | null => {
        const race = races.find((r) => r.id === id)
        if (race === undefined || race.network !== network || race.winner === null) return null
        const age = new Date(at).getTime() - new Date(race.started_at).getTime()
        return age >= 0 && age < 30 * 60_000 ? race.id : null
      }

      if (sql.startsWith('INSERT INTO usage_executions')) {
        const [
          id,
          network,
          hash,
          account,
          kind,
          feeSponsored,
          ok,
          failure,
          submittedAt,
          assetIn,
          assetOut,
          amountIn,
          volumeUsd,
          raceId,
        ] = p as [
          string,
          string,
          string | null,
          string,
          string,
          boolean,
          boolean,
          string | null,
          string,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
        ]
        const duplicate =
          hash !== null && executions.some((e) => e.network === network && e.hash === hash)
        if (duplicate) return { rows: [] }
        executions.push({
          id,
          network,
          hash,
          account,
          kind,
          fee_sponsored: feeSponsored,
          ok,
          failure,
          submitted_at: submittedAt,
          asset_in: assetIn,
          asset_out: assetOut,
          amount_in: amountIn,
          volume_usd: volumeUsd,
          race_id: matchRace(raceId, network, submittedAt),
        })
        return { rows: [{ id }] }
      }

      if (sql.startsWith('INSERT INTO intent_reads')) {
        const [id, network, readAt, understood, action, tokenIn, tokenOut, sizeUsd, reason] = p as [
          string,
          string,
          string,
          boolean,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
        ]
        intentReads.push({
          id,
          network,
          read_at: readAt,
          understood,
          action,
          token_in: tokenIn,
          token_out: tokenOut,
          size_usd: sizeUsd,
          reason,
        })
        return { rows: [{ id }] }
      }

      if (sql.startsWith('INSERT INTO agent_races')) {
        const [
          id,
          network,
          startedAt,
          intentType,
          tokenIn,
          tokenOut,
          sizeUsd,
          agents,
          answered,
          winner,
          unanimous,
          outcome,
          durationMs,
        ] = p as [
          string,
          string,
          string,
          string,
          string,
          string,
          number | null,
          number,
          number,
          string | null,
          boolean | null,
          string,
          number,
        ]
        if (races.some((r) => r.id === id)) return { rows: [] }
        races.push({
          id,
          network,
          started_at: startedAt,
          intent_type: intentType,
          token_in: tokenIn,
          token_out: tokenOut,
          size_usd: sizeUsd,
          agents,
          answered,
          winner,
          unanimous,
          outcome,
          duration_ms: durationMs,
        })
        return { rows: [{ id }] }
      }

      if (sql.startsWith('INSERT INTO agent_proposals')) {
        const [raceId, agent, model, ok, failure, latencyMs, score, won, routeId, mode, reasoning] =
          p as [
            string,
            string,
            string | null,
            boolean,
            string | null,
            number,
            number | null,
            boolean,
            string | null,
            string | null,
            string | null,
          ]
        if (proposals.some((x) => x.race_id === raceId && x.agent === agent)) return { rows: [] }
        proposals.push({
          race_id: raceId,
          agent,
          model,
          ok,
          failure,
          latency_ms: latencyMs,
          score,
          won,
          route_id: routeId,
          execution_mode: mode,
          reasoning,
        })
        return { rows: [{ agent }] }
      }

      // historyForAccount's read: a wallet's executions, each joined to its
      // race and the race's winning proposal (if any). Matched loosely by
      // its opening clause rather than the full text, so a column reorder in
      // the real query does not also require editing this fake.
      if (sql.startsWith('SELECT r.id AS race_id')) {
        const [network, account, limit, offset] = p as [string, string, number, number]
        const rows = executions
          .filter((e) => e.network === network && e.account === account && e.race_id !== null)
          .map((e) => {
            const race = races.find((r) => r.id === e.race_id)
            if (race === undefined) return undefined
            const winning = proposals.find((pr) => pr.race_id === race.id && pr.won)
            return {
              race_id: race.id,
              started_at: race.started_at,
              token_in: race.token_in,
              token_out: race.token_out,
              size_usd: race.size_usd,
              winner: race.winner,
              winning_model: winning?.model ?? null,
              reasoning: winning?.reasoning ?? null,
              executed_hash: e.hash,
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
        return { rows: rows.slice(offset, offset + limit) }
      }

      throw new Error(`fake db: unrecognised statement: ${sql}`)
    },
  }
  return db
}
