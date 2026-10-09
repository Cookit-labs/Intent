import type { QueryFn } from '../../server/standing-rules'

/**
 * An in-memory stand-in for Postgres, for the standing-rules repository.
 *
 * The repository takes a query function rather than a pool, so the unit tests
 * can run without a database. This fake answers exactly the statements the
 * repository issues — matched by shape, not parsed — and nothing else. A
 * statement it does not recognise throws, so a new query cannot silently pass
 * by returning no rows.
 *
 * The real SQL is exercised by `standing-rules.live.test.ts` against the
 * Docker Postgres when `DATABASE_URL` is set.
 */

export interface FakeRow {
  id: string
  email: string
  wallet: string
  chain: string
  network: string
  rule: Record<string, unknown>
  status: string
  created_at: Date
  fired_at: Date | null
  fired_price: number | null
  notified_at: Date | null
  seen_at: Date | null
}

export interface FakeDb {
  query: QueryFn
  rows: Map<string, FakeRow>
  /** Every statement seen, for asserting a call did or did not touch the database. */
  log: string[]
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function fakeStandingRulesDb(): FakeDb {
  const rows = new Map<string, FakeRow>()
  const log: string[] = []

  const query: QueryFn = async (rawSql, params = []) => {
    const sql = normalise(rawSql)
    log.push(sql)
    const p = params as unknown[]

    if (
      sql.startsWith('CREATE TABLE') ||
      sql.startsWith('CREATE INDEX') ||
      sql.startsWith('ALTER TABLE')
    ) {
      return { rows: [] }
    }

    if (sql.startsWith('INSERT INTO standing_rules')) {
      const [id, email, wallet, chain, rule, createdAt, network] = p as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
      const existing = rows.get(id)
      if (existing !== undefined) {
        if (existing.email !== email || existing.network !== network) return { rows: [] }
        existing.rule = JSON.parse(rule) as Record<string, unknown>
        return { rows: [{ ...existing }] }
      }
      const row: FakeRow = {
        id,
        email,
        wallet,
        chain,
        network,
        rule: JSON.parse(rule) as Record<string, unknown>,
        status: 'armed',
        created_at: new Date(createdAt),
        fired_at: null,
        fired_price: null,
        notified_at: null,
        seen_at: null,
      }
      rows.set(id, row)
      return { rows: [{ ...row }] }
    }

    if (
      sql.startsWith('SELECT * FROM standing_rules WHERE email = $1 AND chain = $2 AND fired_at')
    ) {
      const [email, chain, network] = p as [string, string, string]
      return {
        rows: [...rows.values()]
          .filter(
            (r) =>
              r.email === email &&
              r.chain === chain &&
              r.network === network &&
              r.fired_at !== null &&
              r.seen_at === null &&
              r.status !== 'cancelled'
          )
          .sort((a, b) => (b.fired_at?.getTime() ?? 0) - (a.fired_at?.getTime() ?? 0)),
      }
    }

    if (sql.startsWith('SELECT * FROM standing_rules WHERE email = $1 AND chain = $2')) {
      const [email, chain, network] = p as [string, string, string]
      return {
        rows: [...rows.values()]
          .filter((r) => r.email === email && r.chain === chain && r.network === network)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
      }
    }

    if (sql.startsWith('SELECT * FROM standing_rules WHERE email = $1 AND id = $2')) {
      const [email, id, network] = p as [string, string, string]
      const row = rows.get(id)
      return {
        rows: row !== undefined && row.email === email && row.network === network ? [row] : [],
      }
    }

    if (sql.startsWith("SELECT * FROM standing_rules WHERE status = 'armed'")) {
      const [network] = p as [string]
      return {
        rows: [...rows.values()]
          .filter((r) => r.status === 'armed' && r.network === network)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
      }
    }

    if (
      sql.startsWith(
        'SELECT * FROM standing_rules WHERE fired_at IS NOT NULL AND notified_at IS NULL'
      )
    ) {
      const [network] = p as [string]
      return {
        rows: [...rows.values()]
          .filter(
            (r) =>
              r.fired_at !== null &&
              r.notified_at === null &&
              r.status !== 'cancelled' &&
              r.network === network
          )
          .sort((a, b) => (a.fired_at?.getTime() ?? 0) - (b.fired_at?.getTime() ?? 0)),
      }
    }

    if (sql.startsWith("UPDATE standing_rules SET status = 'cancelled'")) {
      const [email, id, network] = p as [string, string, string]
      const row = rows.get(id)
      if (row === undefined || row.email !== email || row.network !== network) return { rows: [] }
      row.status = 'cancelled'
      return { rows: [{ id }] }
    }

    if (sql.startsWith('UPDATE standing_rules SET status = CASE')) {
      const [id, price, at] = p as [string, number | null, string]
      const row = rows.get(id)
      if (row === undefined || row.status !== 'armed') return { rows: [] }
      const trigger = row.rule['trigger'] as { kind: string }
      row.status = trigger.kind === 'schedule' ? 'armed' : 'fired'
      row.fired_at = new Date(at)
      row.fired_price = price
      row.notified_at = null
      row.seen_at = null
      return { rows: [{ id }] }
    }

    if (sql.startsWith('UPDATE standing_rules SET notified_at = $2')) {
      const [id, at] = p as [string, string]
      const row = rows.get(id)
      if (row === undefined || row.notified_at !== null) return { rows: [] }
      row.notified_at = new Date(at)
      return { rows: [{ id }] }
    }

    if (sql.startsWith('UPDATE standing_rules SET seen_at = $3')) {
      const [email, ids, at, network] = p as [string, string[], string, string]
      const touched: { id: string }[] = []
      for (const id of ids) {
        const row = rows.get(id)
        if (row === undefined || row.email !== email || row.network !== network) continue
        if (row.seen_at !== null) continue
        row.seen_at = new Date(at)
        touched.push({ id })
      }
      return { rows: touched }
    }

    throw new Error(`fake db: unrecognised statement: ${sql}`)
  }

  return { query, rows, log }
}
