import type { QueryFn } from '../../server/db'

/**
 * An in-memory stand-in for Postgres, for the help ticket repository.
 *
 * Answers exactly the statements the repository issues, matched by shape, and throws on anything
 * else so a new query cannot pass by returning no rows. A clock that ticks once per write keeps
 * "newest activity first" deterministic.
 */

type Row = Record<string, unknown>

export interface FakeSupportDb {
  query: QueryFn
  tickets: Map<string, Row>
  messages: Row[]
}

export function fakeSupportDb(): FakeSupportDb {
  const tickets = new Map<string, Row>()
  const messages: Row[] = []
  let clock = Date.UTC(2026, 10, 15, 12, 0, 0)
  const now = (): string => new Date((clock += 1000)).toISOString()

  const query: QueryFn = async (rawSql, params = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    const p = params as unknown[]

    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) return { rows: [] }

    if (sql.startsWith('INSERT INTO support_tickets')) {
      const at = now()
      const row: Row = {
        id: p[0],
        requester: p[1],
        wallet: p[2],
        chain: p[3],
        kind: p[4],
        status: 'open',
        title: p[5],
        summary: p[6],
        context: JSON.parse(String(p[7])),
        user_unread: false,
        created_at: at,
        updated_at: at,
      }
      tickets.set(String(p[0]), row)
      return { rows: [{ ...row }] }
    }

    if (sql.startsWith('INSERT INTO support_messages')) {
      messages.push({
        id: messages.length + 1,
        ticket_id: p[0],
        author: p[1],
        body: p[2],
        created_at: now(),
      })
      return { rows: [] }
    }

    if (sql.startsWith('SELECT author, body, created_at FROM support_messages')) {
      return { rows: messages.filter((m) => m.ticket_id === p[0]).map((m) => ({ ...m })) }
    }

    if (sql === 'SELECT * FROM support_tickets WHERE id = $1 AND requester = $2') {
      const row = tickets.get(String(p[0]))
      return { rows: row !== undefined && row['requester'] === p[1] ? [{ ...row }] : [] }
    }

    if (sql === 'SELECT * FROM support_tickets WHERE id = $1') {
      const row = tickets.get(String(p[0]))
      return { rows: row !== undefined ? [{ ...row }] : [] }
    }

    if (sql.startsWith('SELECT * FROM support_tickets')) {
      const conditions = [...sql.matchAll(/(status|kind|chain|requester) = \$(\d+)/g)].map(
        (m) => [m[1] as string, p[Number(m[2]) - 1]] as const
      )
      const rows = [...tickets.values()]
        .filter((row) => conditions.every(([column, value]) => row[column] === value))
        .sort((a, b) => String(b['updated_at']).localeCompare(String(a['updated_at'])))
        .map((row) => ({ ...row }))
      return { rows }
    }

    if (sql.startsWith('UPDATE support_tickets SET user_unread = false')) {
      const row = tickets.get(String(p[0]))
      if (row !== undefined && row['requester'] === p[1]) row['user_unread'] = false
      return { rows: [] }
    }

    if (sql.startsWith("UPDATE support_tickets SET status = 'open'")) {
      const row = tickets.get(String(p[0]))
      if (row === undefined || row['requester'] !== p[1]) return { rows: [] }
      row['status'] = 'open'
      row['updated_at'] = now()
      return { rows: [{ id: row['id'] }] }
    }

    if (sql.startsWith("UPDATE support_tickets SET status = 'answered'")) {
      const row = tickets.get(String(p[0]))
      if (row === undefined) return { rows: [] }
      row['status'] = 'answered'
      row['user_unread'] = true
      row['updated_at'] = now()
      return { rows: [{ id: row['id'] }] }
    }

    if (sql.startsWith('UPDATE support_tickets SET status = $2')) {
      const row = tickets.get(String(p[0]))
      if (row === undefined) return { rows: [] }
      row['status'] = p[1]
      row['updated_at'] = now()
      return { rows: [{ id: row['id'] }] }
    }

    throw new Error(`fake support db: unrecognised statement: ${sql}`)
  }

  return { query, tickets, messages }
}
