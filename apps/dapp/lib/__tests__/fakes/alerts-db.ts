import type { QueryFn } from '../../server/standing-rules'

/**
 * An in-memory stand-in for Postgres, for the alerts repository.
 *
 * The same idea as `fakeStandingRulesDb`: answers exactly the statements the
 * repository issues, matched by shape, and throws on anything else so a new
 * query cannot pass by returning no rows.
 */

export interface FakeAlertsDb {
  query: QueryFn
  /** `${kind}:${day}` for every alert marked sent. */
  sent: Set<string>
  log: string[]
}

export function fakeAlertsDb(): FakeAlertsDb {
  const sent = new Set<string>()
  const log: string[] = []

  const query: QueryFn = async (rawSql, params = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    log.push(sql)
    const p = params as unknown[]

    if (sql.startsWith('CREATE TABLE')) return { rows: [] }

    if (sql.startsWith('SELECT 1 FROM alerts_sent')) {
      const [kind, day] = p as [string, string]
      return { rows: sent.has(`${kind}:${day}`) ? [{ '?column?': 1 }] : [] }
    }

    if (sql.startsWith('INSERT INTO alerts_sent')) {
      const [kind, day] = p as [string, string]
      sent.add(`${kind}:${day}`)
      return { rows: [] }
    }

    throw new Error(`fake alerts db: unrecognised statement: ${sql}`)
  }

  return { query, sent, log }
}
