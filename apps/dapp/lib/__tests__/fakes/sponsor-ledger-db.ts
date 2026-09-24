import type { QueryFn } from '../../server/db'

/**
 * An in-memory stand-in for Postgres, for the sponsor ledger.
 *
 * Answers the statements the ledger issues — matched by shape, not parsed —
 * and throws on anything else. Setting `down` makes every statement fail.
 * `stroops` comes back as a string, because that is how pg returns BIGINT
 * and the ledger's conversion should be exercised the same way here.
 *
 * The real SQL is exercised by `sponsor-ledger.live.test.ts` against the
 * Docker Postgres when `DATABASE_URL` is set.
 */

export interface FakeLedgerRow {
  stroops: bigint
  count: number
}

export interface FakeSponsorLedgerDb {
  query: QueryFn
  /** Rows keyed `<day>|<account>`; the day total is under account `*`. */
  rows: Map<string, FakeLedgerRow>
  log: string[]
  /** When set, every statement rejects with this error. */
  down?: Error
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function fakeSponsorLedgerDb(): FakeSponsorLedgerDb {
  const rows = new Map<string, FakeLedgerRow>()
  const log: string[] = []

  const db: FakeSponsorLedgerDb = {
    rows,
    log,
    query: async (rawSql, params = []) => {
      const sql = normalise(rawSql)
      log.push(sql)
      if (db.down !== undefined) throw db.down
      const p = params as unknown[]

      if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
        return { rows: [] }
      }

      if (sql.startsWith('SELECT account, stroops, count FROM sponsor_ledger')) {
        const [day, accounts] = p as [string, string[]]
        return {
          rows: accounts.flatMap((account) => {
            const row = rows.get(`${day}|${account}`)
            return row === undefined
              ? []
              : [{ account, stroops: row.stroops.toString(), count: row.count }]
          }),
        }
      }

      if (sql.startsWith('INSERT INTO sponsor_ledger')) {
        const [day, account, stroops] = p as [string, string, string]
        const returned: Record<string, unknown>[] = []
        for (const who of [account, '*']) {
          const id = `${day}|${who}`
          const row = rows.get(id) ?? { stroops: BigInt(0), count: 0 }
          const next = { stroops: row.stroops + BigInt(stroops), count: row.count + 1 }
          rows.set(id, next)
          returned.push({ account: who, stroops: next.stroops.toString(), count: next.count })
        }
        return { rows: returned }
      }

      if (sql.startsWith('UPDATE sponsor_ledger SET stroops = sponsor_ledger.stroops - $3')) {
        const [day, account, stroops] = p as [string, string, string]
        for (const who of [account, '*']) {
          const row = rows.get(`${day}|${who}`)
          if (row === undefined) continue
          row.stroops -= BigInt(stroops)
          row.count -= 1
        }
        return { rows: [] }
      }

      throw new Error(`fake db: unrecognised statement: ${sql}`)
    },
  }

  return db
}
