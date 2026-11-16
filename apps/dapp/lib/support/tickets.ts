import { randomUUID } from 'node:crypto'

import { getPool, type QueryFn } from '../server/db'

/**
 * Help tickets: what a person raised from the help button, and the thread with the team after it.
 *
 * A ticket belongs to a requester, the same key the rest of the app files a person's records under
 * (`requesterOf`): the signed-in email, or `wallet:<address>`. Only the requester and the admin read
 * a thread.
 *
 * The chat with the assistant before a ticket is not stored. When it becomes a ticket, the
 * conversation so far is copied in as its first messages, so the team reads what the person already
 * said.
 *
 * The tables are created on first use, as the other stores are. Keep
 * packages/db/migrations/018_support_tickets.sql in sync.
 */

export const SUPPORT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id          TEXT        PRIMARY KEY,
    requester   TEXT        NOT NULL,
    wallet      TEXT,
    chain       TEXT,
    kind        TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'open',
    title       TEXT        NOT NULL,
    summary     TEXT        NOT NULL,
    context     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    user_unread BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS support_tickets_requester ON support_tickets (requester, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    id         BIGSERIAL   PRIMARY KEY,
    ticket_id  TEXT        NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
    author     TEXT        NOT NULL,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages (ticket_id, id)`,
]

export const TICKET_KINDS = ['problem', 'suggestion', 'complaint'] as const
export type TicketKind = (typeof TICKET_KINDS)[number]

/** `open`: the team owes a reply. `answered`: the team replied. `closed`: done. */
export const TICKET_STATUSES = ['open', 'answered', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export type MessageAuthor = 'user' | 'assistant' | 'admin'

/** The longest message kept, user or admin. Longer text is refused, not cut. */
export const MAX_MESSAGE_CHARS = 2000

/** One of the person's orders as it stood when they asked. No bank details. */
export interface OrderSnapshot {
  id: string
  kind: 'offramp' | 'naira'
  chain: string
  provider: string
  status: string
  providerStatus: string
  amount: string
  coin: string
  payout: string
  currency: string
  depositSent: boolean
  createdAt: string
}

export interface TicketMessage {
  author: MessageAuthor
  body: string
  createdAt: string
}

export interface Ticket {
  id: string
  requester: string
  wallet: string | undefined
  chain: string | undefined
  kind: TicketKind
  status: TicketStatus
  title: string
  summary: string
  context: OrderSnapshot[]
  userUnread: boolean
  createdAt: string
  updatedAt: string
}

export interface TicketWithMessages extends Ticket {
  messages: TicketMessage[]
}

export interface NewTicket {
  requester: string
  wallet: string | undefined
  chain: string | undefined
  kind: TicketKind
  title: string
  summary: string
  context: OrderSnapshot[]
  messages: { author: MessageAuthor; body: string }[]
}

export interface TicketFilter {
  status?: TicketStatus | undefined
  kind?: TicketKind | undefined
  chain?: string | undefined
}

export interface SupportRepo {
  ensureSchema: () => Promise<void>
  create: (ticket: NewTicket) => Promise<Ticket>
  /** The requester's tickets, newest activity first. */
  listForRequester: (requester: string) => Promise<Ticket[]>
  /** Undefined when the ticket is not this requester's, as when it does not exist. */
  getForRequester: (id: string, requester: string) => Promise<TicketWithMessages | undefined>
  /** Adds the requester's reply and reopens the ticket. False when it is not theirs. */
  addUserMessage: (id: string, requester: string, body: string) => Promise<boolean>
  markRead: (id: string, requester: string) => Promise<void>
  listAll: (filter: TicketFilter) => Promise<Ticket[]>
  get: (id: string) => Promise<TicketWithMessages | undefined>
  /** Adds the team's reply, marks it answered and unread for the person. False when no such ticket. */
  addAdminReply: (id: string, body: string) => Promise<boolean>
  setStatus: (id: string, status: TicketStatus) => Promise<boolean>
}

function isKind(value: unknown): value is TicketKind {
  return typeof value === 'string' && (TICKET_KINDS as readonly string[]).includes(value)
}

function isStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value)
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString()
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

function contextOf(value: unknown): OrderSnapshot[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? (parsed as OrderSnapshot[]) : []
}

function fromDb(r: Record<string, unknown>): Ticket {
  return {
    id: String(r['id']),
    requester: String(r['requester']),
    wallet: optional(r['wallet']),
    chain: optional(r['chain']),
    kind: isKind(r['kind']) ? r['kind'] : 'problem',
    status: isStatus(r['status']) ? r['status'] : 'open',
    title: String(r['title']),
    summary: String(r['summary']),
    context: contextOf(r['context']),
    userUnread: r['user_unread'] === true,
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  }
}

function messageFromDb(r: Record<string, unknown>): TicketMessage {
  const author = r['author']
  return {
    author: author === 'assistant' || author === 'admin' ? author : 'user',
    body: String(r['body']),
    createdAt: iso(r['created_at']),
  }
}

export function createSupportRepo(query: QueryFn, newId: () => string = randomUUID): SupportRepo {
  async function messagesOf(id: string): Promise<TicketMessage[]> {
    const { rows } = await query(
      `SELECT author, body, created_at FROM support_messages WHERE ticket_id = $1 ORDER BY id`,
      [id]
    )
    return rows.map(messageFromDb)
  }

  async function addMessage(id: string, author: MessageAuthor, body: string): Promise<void> {
    await query(`INSERT INTO support_messages (ticket_id, author, body) VALUES ($1, $2, $3)`, [
      id,
      author,
      body,
    ])
  }

  return {
    async ensureSchema() {
      for (const statement of SUPPORT_DDL) await query(statement)
    },

    async create(ticket) {
      const id = newId()
      const { rows } = await query(
        `INSERT INTO support_tickets (id, requester, wallet, chain, kind, title, summary, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          id,
          ticket.requester,
          ticket.wallet ?? null,
          ticket.chain ?? null,
          ticket.kind,
          ticket.title,
          ticket.summary,
          JSON.stringify(ticket.context),
        ]
      )
      for (const message of ticket.messages) await addMessage(id, message.author, message.body)
      return fromDb(rows[0] as Record<string, unknown>)
    },

    async listForRequester(requester) {
      const { rows } = await query(
        `SELECT * FROM support_tickets WHERE requester = $1 ORDER BY updated_at DESC LIMIT 50`,
        [requester]
      )
      return rows.map(fromDb)
    },

    async getForRequester(id, requester) {
      const { rows } = await query(
        `SELECT * FROM support_tickets WHERE id = $1 AND requester = $2`,
        [id, requester]
      )
      const row = rows[0]
      if (row === undefined) return undefined
      return { ...fromDb(row), messages: await messagesOf(id) }
    },

    async addUserMessage(id, requester, body) {
      const { rows } = await query(
        `UPDATE support_tickets SET status = 'open', updated_at = now()
          WHERE id = $1 AND requester = $2 RETURNING id`,
        [id, requester]
      )
      if (rows.length === 0) return false
      await addMessage(id, 'user', body)
      return true
    },

    async markRead(id, requester) {
      await query(
        `UPDATE support_tickets SET user_unread = false WHERE id = $1 AND requester = $2`,
        [id, requester]
      )
    },

    async listAll(filter) {
      const where: string[] = []
      const params: unknown[] = []
      if (filter.status !== undefined) {
        params.push(filter.status)
        where.push(`status = $${params.length}`)
      }
      if (filter.kind !== undefined) {
        params.push(filter.kind)
        where.push(`kind = $${params.length}`)
      }
      if (filter.chain !== undefined) {
        params.push(filter.chain)
        where.push(`chain = $${params.length}`)
      }
      const { rows } = await query(
        `SELECT * FROM support_tickets${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
          ORDER BY updated_at DESC LIMIT 200`,
        params
      )
      return rows.map(fromDb)
    },

    async get(id) {
      const { rows } = await query(`SELECT * FROM support_tickets WHERE id = $1`, [id])
      const row = rows[0]
      if (row === undefined) return undefined
      return { ...fromDb(row), messages: await messagesOf(id) }
    },

    async addAdminReply(id, body) {
      const { rows } = await query(
        `UPDATE support_tickets SET status = 'answered', user_unread = true, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [id]
      )
      if (rows.length === 0) return false
      await addMessage(id, 'admin', body)
      return true
    },

    async setStatus(id, status) {
      const { rows } = await query(
        `UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, status]
      )
      return rows.length > 0
    },
  }
}

const globalForSupport = globalThis as unknown as { intentSupportSchema?: Promise<void> }

/** The production repository, over the shared pool; the schema is created on first use. */
export async function getSupportRepo(): Promise<SupportRepo> {
  const pool = getPool()
  const repo = createSupportRepo(async (sql, params) => {
    const result = await pool.query(sql, params)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForSupport.intentSupportSchema === undefined) {
    globalForSupport.intentSupportSchema = repo.ensureSchema().catch((e: unknown) => {
      delete globalForSupport.intentSupportSchema
      throw e
    })
  }
  await globalForSupport.intentSupportSchema
  return repo
}

export { isKind as isTicketKind, isStatus as isTicketStatus }
