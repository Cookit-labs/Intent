import { activeNetwork } from '@intent/config'

import { getPool, withTimeout, type QueryFn } from './db'

/**
 * Whether the agent roster is actually answering, read from the races the
 * app already logs — not a synthetic check that runs its own race.
 *
 * A dedicated active check (calling `brain.propose()` on a few cheap agents
 * on a timer) was the alternative; this is cheaper and catches exactly what
 * a human running curl against production was catching by hand: real
 * requests from real traffic failing. Its blind spot — a quiet deployment
 * with no traffic for the window — is accepted rather than paid for with a
 * synthetic race that spends the paid agent's own budget just to prove it
 * is reachable.
 *
 * "Core" agents are everything but OpenRouter: OpenRouter's free models
 * rotate and get benched on their own free-tier limits (see `lineup.ts`),
 * which is normal operation, not an outage, so a single OpenRouter model
 * failing never triggers an alert on its own.
 */

const CORE_PROVIDERS = ['anthropic', 'deepseek', 'groq', 'ollama'] as const

export interface AgentHealthWindow {
  /** How far back the window reaches. */
  hours: number
  /** Races observed in the window — too few to judge is its own signal. */
  races: number
}

export interface CoreAgentHealth {
  agent: string
  races: number
  answered: number
}

export interface AgentHealthReport {
  network: string
  window: AgentHealthWindow
  /** Every "core" agent configured, i.e. seen in this window — those that answered zero times are the critical signal. */
  coreAgents: CoreAgentHealth[]
  /** Across every agent, core and OpenRouter alike. */
  answeredTotal: number
  askedTotal: number
  /** `undefined` when `askedTotal` is zero — nothing to divide. */
  answerRate: number | undefined
  /**
   * The verdict this report's numbers support. Computed here rather than by
   * the caller, so the thresholds live in one place: too few races to judge
   * (fewer than `MIN_RACES_TO_JUDGE`), a dead core agent, a roster-wide
   * answer rate that is low or zero.
   */
  severity: 'ok' | 'warning' | 'critical' | 'insufficient_data'
  /** One line per reason `severity` is what it is; empty when `severity` is 'ok'. */
  reasons: string[]
}

/** Below this many races in the window, a rate is noise, not a signal. */
const MIN_RACES_TO_JUDGE = 3

export function reportFrom(
  network: string,
  window: AgentHealthWindow,
  coreAgents: CoreAgentHealth[],
  answeredTotal: number,
  askedTotal: number
): AgentHealthReport {
  const answerRate = askedTotal > 0 ? answeredTotal / askedTotal : undefined
  const reasons: string[] = []

  if (window.races < MIN_RACES_TO_JUDGE) {
    return {
      network,
      window,
      coreAgents,
      answeredTotal,
      askedTotal,
      answerRate,
      severity: 'insufficient_data',
      reasons: [`only ${window.races} race(s) in the last ${window.hours}h — too few to judge`],
    }
  }

  const deadCore = coreAgents.filter((a) => a.races > 0 && a.answered === 0)
  for (const a of deadCore) {
    reasons.push(`${a.agent} answered 0 of ${a.races} races in the last ${window.hours}h`)
  }

  let severity: AgentHealthReport['severity'] = 'ok'
  if (answerRate !== undefined && answerRate === 0) {
    severity = 'critical'
    reasons.push(`no agent answered any of ${askedTotal} asks in the last ${window.hours}h`)
  } else if (deadCore.length > 0) {
    severity = 'critical'
  } else if (answerRate !== undefined && answerRate < 0.5) {
    severity = 'warning'
    reasons.push(
      `only ${(answerRate * 100).toFixed(0)}% of asks were answered in the last ${window.hours}h`
    )
  }

  return { network, window, coreAgents, answeredTotal, askedTotal, answerRate, severity, reasons }
}

/** Reads the report for one network, over a rolling window ending now. */
export async function readAgentHealth(
  query: QueryFn,
  network: string = activeNetwork(),
  hours = 24,
  now: Date = new Date()
): Promise<AgentHealthReport> {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString()

  const [{ rows: raceRows }, { rows: agentRows }] = await Promise.all([
    query(
      `SELECT count(*) AS n, coalesce(sum(agents), 0) AS asked, coalesce(sum(answered), 0) AS answered
         FROM agent_races WHERE network = $1 AND started_at >= $2`,
      [network, since]
    ),
    query(
      `SELECT p.agent, count(*) AS races, count(*) FILTER (WHERE p.ok) AS answered
         FROM agent_proposals p JOIN agent_races r ON r.id = p.race_id
        WHERE r.network = $1 AND r.started_at >= $2
        GROUP BY p.agent`,
      [network, since]
    ),
  ])

  const races = Number(raceRows[0]?.['n'] ?? 0)
  const askedTotal = Number(raceRows[0]?.['asked'] ?? 0)
  const answeredTotal = Number(raceRows[0]?.['answered'] ?? 0)

  const coreAgents: CoreAgentHealth[] = agentRows
    .map((row) => ({
      agent: String(row['agent']),
      races: Number(row['races']),
      answered: Number(row['answered']),
    }))
    .filter((a) =>
      CORE_PROVIDERS.includes(a.agent.split(':')[0] as (typeof CORE_PROVIDERS)[number])
    )

  return reportFrom(network, { hours, races }, coreAgents, answeredTotal, askedTotal)
}

/** The production reader, over the shared pool. */
export async function getAgentHealth(network?: string, hours?: number): Promise<AgentHealthReport> {
  const pool = getPool()
  return readAgentHealth(
    async (sql, params) => {
      const result = await withTimeout(pool.query(sql, params), 8_000)
      return { rows: result.rows as Record<string, unknown>[] }
    },
    network,
    hours
  )
}
