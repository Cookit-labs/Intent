import { getPool } from './db'
import type { QueryFn } from './standing-rules'

/**
 * Which operator alerts have gone out, and the settings that govern them.
 *
 * An alert that repeats every minute is one that gets filtered, so each kind
 * is sent at most once a day: a row here is the record that today's went.
 * The day is the UTC date of the tick that sent it — good enough for "not
 * again until tomorrow", and the same on every machine.
 *
 * The table is created on first use for the same reason standing_rules is:
 * migration files run only at first container init. Keep
 * packages/db/migrations/005_alerts_sent.sql in sync.
 */

export const ALERTS_SENT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS alerts_sent (
    kind    TEXT        NOT NULL,
    day     DATE        NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, day)
  )`,
]

export interface AlertsRepo {
  ensureSchema: () => Promise<void>
  /** Whether this kind already went out on this day (YYYY-MM-DD, UTC). */
  wasSent: (kind: string, day: string) => Promise<boolean>
  markSent: (kind: string, day: string) => Promise<void>
}

export function createAlertsRepo(query: QueryFn): AlertsRepo {
  return {
    async ensureSchema() {
      for (const statement of ALERTS_SENT_DDL) await query(statement)
    },

    async wasSent(kind, day) {
      const { rows } = await query(`SELECT 1 FROM alerts_sent WHERE kind = $1 AND day = $2`, [
        kind,
        day,
      ])
      return rows.length > 0
    },

    async markSent(kind, day) {
      await query(`INSERT INTO alerts_sent (kind, day) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        kind,
        day,
      ])
    },
  }
}

const globalForAlerts = globalThis as unknown as { intentAlertsSchema?: Promise<void> }

/** The production repository, over the shared pool; the schema is created on first use. */
export async function getAlertsRepo(): Promise<AlertsRepo> {
  const pool = getPool()
  const repo = createAlertsRepo(async (sql, params) => {
    const result = await pool.query(sql, params)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForAlerts.intentAlertsSchema === undefined) {
    globalForAlerts.intentAlertsSchema = repo.ensureSchema().catch((e: unknown) => {
      // A failed attempt must not be cached as success, or every later call
      // would skip the DDL and fail on a missing table with a worse message.
      delete globalForAlerts.intentAlertsSchema
      throw e
    })
  }
  await globalForAlerts.intentAlertsSchema

  return repo
}

type Env = Record<string, string | undefined>

const DEFAULT_SPONSOR_ALERT_XLM = 20

/** Who operator alerts go to. Undefined means nobody asked, and nothing is sent. */
export function alertRecipient(env: Env = process.env): string | undefined {
  const to = env['ALERT_EMAIL']?.trim()
  return to === undefined || to === '' ? undefined : to
}

/**
 * The balance below which the sponsor alert fires. 20 XLM unless
 * SPONSOR_ALERT_XLM says otherwise; a value that is not a positive number
 * falls back rather than alerting on every tick or never.
 */
export function sponsorAlertThreshold(env: Env = process.env): number {
  const raw = env['SPONSOR_ALERT_XLM']?.trim()
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPONSOR_ALERT_XLM
}
