import type { StandingIntent, StandingStatus } from '../standing-intent'
import { getPool, type QueryFn } from './db'

/**
 * Where standing rules live now: Postgres, so a scheduled tick can evaluate
 * them with no browser open.
 *
 * The rule itself is stored as JSON — it is the client's `StandingIntent`,
 * and nothing server-side needs to index inside it. What the server *does*
 * need to know is held in columns: who owns the rule, whether it has fired,
 * at what price, whether the owner has been emailed, and whether they have
 * looked at it. Those columns are the record; the JSON's own `status` is
 * whatever the client last sent and is overridden on the way out.
 *
 * The repository takes a query function rather than the pool so unit tests
 * can run it against an in-memory fake. `getStandingRulesRepo` is the
 * production wiring.
 */

export type { QueryFn }

/** A rule as the server holds it. Timestamps are ISO strings; absent ones are null. */
export interface StoredStandingRule {
  id: string
  email: string
  wallet: string
  chain: string
  /** The intent, with `status` and `lastFiredAt` reconciled from the columns. */
  rule: StandingIntent
  status: StandingStatus
  createdAt: string
  firedAt: string | null
  firedPrice: number | null
  notifiedAt: string | null
  seenAt: string | null
}

export interface StandingRulesRepo {
  ensureSchema: () => Promise<void>
  /** Undefined when the id already belongs to a different owner. */
  createRule: (input: {
    email: string
    wallet: string
    rule: StandingIntent
  }) => Promise<StoredStandingRule | undefined>
  listRules: (email: string, chain: string) => Promise<StoredStandingRule[]>
  findRule: (email: string, id: string) => Promise<StoredStandingRule | undefined>
  /** False when no rule of that owner has that id. */
  cancelRule: (email: string, id: string) => Promise<boolean>
  armedRules: () => Promise<StoredStandingRule[]>
  markFired: (id: string, price: number | null, at: Date) => Promise<void>
  markNotified: (id: string, at?: Date) => Promise<void>
  /** Fired rules whose owner has not yet been emailed. */
  unnotifiedFired: () => Promise<StoredStandingRule[]>
  unseenFired: (email: string, chain: string) => Promise<StoredStandingRule[]>
  markSeen: (email: string, ids: string[], at?: Date) => Promise<void>
}

/**
 * The table, as the migration file also states it.
 *
 * Duplicated deliberately. Migration files are mounted into Postgres only at
 * first container init, so a database created before this feature never
 * runs `002_standing_rules.sql`. Running the same idempotent statements here
 * on first use means both a fresh database and an existing one work without
 * an operator step. Keep the two in sync.
 */
export const STANDING_RULES_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS standing_rules (
    id            TEXT        PRIMARY KEY,
    email         TEXT        NOT NULL,
    wallet        TEXT        NOT NULL,
    chain         TEXT        NOT NULL,
    rule          JSONB       NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'armed'
                  CHECK (status IN ('armed', 'fired', 'cancelled', 'expired')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    fired_at      TIMESTAMPTZ,
    fired_price   NUMERIC,
    notified_at   TIMESTAMPTZ,
    seen_at       TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS standing_rules_status_idx ON standing_rules (status)`,
  `CREATE INDEX IF NOT EXISTS standing_rules_owner_idx ON standing_rules (email, chain)`,
]

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

function toStored(row: Record<string, unknown>): StoredStandingRule {
  const status = row['status'] as StandingStatus
  const firedAt = iso(row['fired_at'])
  const base = row['rule'] as StandingIntent
  const priceRaw = row['fired_price']

  return {
    id: String(row['id']),
    email: String(row['email']),
    wallet: String(row['wallet']),
    chain: String(row['chain']),
    rule: {
      ...base,
      id: String(row['id']),
      chain: String(row['chain']),
      status,
      // The evaluator measures a schedule's next interval from this field, so
      // the column has to flow back into the intent the tick evaluates.
      ...(firedAt !== null ? { lastFiredAt: firedAt } : {}),
    },
    status,
    createdAt: iso(row['created_at']) ?? new Date(0).toISOString(),
    firedAt,
    // NUMERIC comes back from pg as a string.
    firedPrice: priceRaw === null || priceRaw === undefined ? null : Number(priceRaw),
    notifiedAt: iso(row['notified_at']),
    seenAt: iso(row['seen_at']),
  }
}

export function createStandingRulesRepo(query: QueryFn): StandingRulesRepo {
  return {
    async ensureSchema() {
      for (const statement of STANDING_RULES_DDL) await query(statement)
    },

    async createRule({ email, wallet, rule }) {
      // Ids come from the client and are guessable, so the upsert only
      // replaces a row the same owner wrote. A conflicting id under another
      // owner updates nothing and returns nothing.
      const { rows } = await query(
        `INSERT INTO standing_rules (id, email, wallet, chain, rule, status, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'armed', $6)
         ON CONFLICT (id) DO UPDATE SET rule = EXCLUDED.rule
           WHERE standing_rules.email = EXCLUDED.email
         RETURNING *`,
        [rule.id, email, wallet, rule.chain, JSON.stringify(rule), rule.createdAt]
      )
      const row = rows[0]
      return row === undefined ? undefined : toStored(row)
    },

    async listRules(email, chain) {
      const { rows } = await query(
        `SELECT * FROM standing_rules WHERE email = $1 AND chain = $2 ORDER BY created_at DESC`,
        [email, chain]
      )
      return rows.map(toStored)
    },

    async findRule(email, id) {
      const { rows } = await query(`SELECT * FROM standing_rules WHERE email = $1 AND id = $2`, [
        email,
        id,
      ])
      const row = rows[0]
      return row === undefined ? undefined : toStored(row)
    },

    async cancelRule(email, id) {
      const { rows } = await query(
        `UPDATE standing_rules SET status = 'cancelled' WHERE email = $1 AND id = $2 RETURNING id`,
        [email, id]
      )
      return rows.length > 0
    },

    async armedRules() {
      const { rows } = await query(
        `SELECT * FROM standing_rules WHERE status = 'armed' ORDER BY created_at ASC`
      )
      return rows.map(toStored)
    },

    async markFired(id, price, at) {
      // A one-off rule is spent by firing; a scheduled one stays armed and
      // the next interval is measured from `fired_at`. Both reset the
      // notified and seen marks, because each firing is a new thing to tell
      // the owner about. Guarded on `armed` so a rule cannot fire twice.
      await query(
        `UPDATE standing_rules
         SET status = CASE WHEN rule->'trigger'->>'kind' = 'schedule' THEN 'armed' ELSE 'fired' END,
             fired_at = $3,
             fired_price = $2,
             notified_at = NULL,
             seen_at = NULL
         WHERE id = $1 AND status = 'armed'`,
        [id, price, at.toISOString()]
      )
    },

    async markNotified(id, at = new Date()) {
      await query(
        `UPDATE standing_rules SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL`,
        [id, at.toISOString()]
      )
    },

    async unnotifiedFired() {
      const { rows } = await query(
        `SELECT * FROM standing_rules
         WHERE fired_at IS NOT NULL AND notified_at IS NULL AND status <> 'cancelled'
         ORDER BY fired_at ASC`
      )
      return rows.map(toStored)
    },

    async unseenFired(email, chain) {
      const { rows } = await query(
        `SELECT * FROM standing_rules
         WHERE email = $1 AND chain = $2 AND fired_at IS NOT NULL AND seen_at IS NULL
           AND status <> 'cancelled'
         ORDER BY fired_at DESC`,
        [email, chain]
      )
      return rows.map(toStored)
    },

    async markSeen(email, ids, at = new Date()) {
      if (ids.length === 0) return
      await query(
        `UPDATE standing_rules SET seen_at = $3
         WHERE email = $1 AND id = ANY($2::text[]) AND seen_at IS NULL`,
        [email, ids, at.toISOString()]
      )
    },
  }
}

/**
 * The production repository, over the shared pool.
 *
 * The schema is created on first use and the promise is cached on
 * `globalThis` for the same reason the pool is: Next's dev server re-evaluates
 * modules on hot reload, and without this every edit would re-run the DDL.
 */
const globalForRules = globalThis as unknown as { intentStandingSchema?: Promise<void> }

export async function getStandingRulesRepo(): Promise<StandingRulesRepo> {
  const pool = getPool()
  const repo = createStandingRulesRepo(async (sql, params) => {
    const result = await pool.query(sql, params)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForRules.intentStandingSchema === undefined) {
    globalForRules.intentStandingSchema = repo.ensureSchema().catch((e: unknown) => {
      // A failed attempt must not be cached as success, or every later call
      // would skip the DDL and fail on a missing table with a worse message.
      delete globalForRules.intentStandingSchema
      throw e
    })
  }
  await globalForRules.intentStandingSchema

  return repo
}
