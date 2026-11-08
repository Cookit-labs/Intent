import { getPool, withTimeout, type QueryFn } from '../server/db'
import type { LinqClient } from '../linq/client'
import type { PayoutProvider as CashoutProvider } from './best-payout'
import type { WeaveClient, WeaveOrder } from './client'
import { isFinal, mapProviderStatus, nextLinqStatus, nextStatus, type WeaveStatus } from './status'
import {
  weaveAssetKey,
  weaveChainId,
  type CashoutChain,
  type DepositChain,
  type DepositExpectation,
} from './types'

/**
 * Cash-out orders through Weave, one row each.
 *
 * The account identifier is stored here because the payout and support need it,
 * and nowhere else: it is not written to chat history, logs or analytics, and
 * `toPublic` below is the only shape that leaves the server.
 */

export const WEAVE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS weave_orders (
    id                 UUID        PRIMARY KEY,
    chain              TEXT        NOT NULL,
    email              TEXT        NOT NULL,
    account            TEXT        NOT NULL,
    provider_order     TEXT        NOT NULL UNIQUE,
    idempotency_key    TEXT        NOT NULL UNIQUE,
    currency           TEXT        NOT NULL,
    institution_code   TEXT        NOT NULL,
    institution_name   TEXT        NOT NULL,
    account_identifier TEXT        NOT NULL,
    account_name       TEXT        NOT NULL,
    deposit_address    TEXT        NOT NULL,
    deposit_memo       TEXT,
    amount             TEXT        NOT NULL,
    estimated_dest     TEXT        NOT NULL,
    expires_at         TIMESTAMPTZ,
    status             TEXT        NOT NULL,
    provider_status    TEXT        NOT NULL,
    deposit_hash       TEXT        UNIQUE,
    send_started_at    TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS weave_orders_email_idx ON weave_orders (email, created_at)`,
  `CREATE INDEX IF NOT EXISTS weave_orders_account_idx ON weave_orders (account, created_at)`,
  // What a paid order actually paid out, which can differ from the estimate it was made with.
  `ALTER TABLE weave_orders ADD COLUMN IF NOT EXISTS paid_dest TEXT`,
  // Who holds the order: Weave, or Linq where it pays more naira. Rows from before are Weave's.
  `ALTER TABLE weave_orders ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'weave'`,
]

/** Said wherever a deposit may already be on its way, so nobody pays twice. */
export const SEND_STARTED =
  "A deposit for this cash-out has already been sent or may be on its way. Do not send it again. Check your wallet's activity, and wait for this cash-out to update."

export interface WeaveOrderRow {
  id: string
  chain: CashoutChain
  email: string
  account: string
  providerOrder: string
  /** Who holds the order. Older rows have none, and are Weave's. */
  provider?: CashoutProvider | undefined
  idempotencyKey: string
  currency: string
  institutionCode: string
  institutionName: string
  accountIdentifier: string
  accountName: string
  depositAddress: string
  depositMemo: string | undefined
  /** USDC to deposit, display units. Decimal text, because this becomes a payment amount. */
  amount: string
  estimatedDest: string
  /** What it actually paid out, once Weave says so. */
  paidDest?: string | undefined
  expiresAt: string | undefined
  status: WeaveStatus
  providerStatus: string
  depositHash: string | undefined
  /**
   * A send was attempted and has not been shown to have failed. Held in the record
   * and not only on the page, because a reload would otherwise forget it and a
   * second deposit could be built for money that has already moved.
   */
  sendStarted: boolean
  createdAt: string
}

/** What the browser is allowed to see: the account identifier is masked. */
export interface WeaveOrderView {
  id: string
  chain: CashoutChain
  status: WeaveStatus
  currency: string
  amount: string
  estimatedDest: string
  /** Linq locks the naira when the order is made, so its figure is what is paid. */
  exactDest?: boolean | undefined
  /** What it actually paid out, once Weave says so. */
  paidDest?: string | undefined
  institutionName: string
  accountName: string
  accountMask: string
  depositAddress: string
  depositMemo: string | undefined
  depositHash: string | undefined
  expiresAt: string | undefined
  createdAt: string
}

export function toPublic(row: WeaveOrderRow): WeaveOrderView {
  const identifier = row.accountIdentifier
  return {
    id: row.id,
    chain: row.chain,
    status: row.status,
    currency: row.currency,
    amount: row.amount,
    estimatedDest: row.estimatedDest,
    ...(row.provider === 'linq' ? { exactDest: true } : {}),
    ...(row.paidDest !== undefined ? { paidDest: row.paidDest } : {}),
    institutionName: row.institutionName,
    accountName: row.accountName,
    accountMask: `••••${identifier.length > 4 ? identifier.slice(-4) : ''}`,
    depositAddress: row.depositAddress,
    depositMemo: row.depositMemo,
    depositHash: row.depositHash,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

/**
 * Weave sends null or an empty string for "no memo". Every chain's deposit check
 * treats those as a memo and refuses, so they never get past here.
 */
export function cleanMemo(memo: unknown): string | undefined {
  return typeof memo === 'string' && memo !== '' ? memo : undefined
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function fromDb(r: Record<string, unknown>): WeaveOrderRow {
  const expires = r['expires_at']
  return {
    id: String(r['id']),
    chain: String(r['chain']) as CashoutChain,
    email: String(r['email']),
    account: String(r['account']),
    providerOrder: String(r['provider_order']),
    provider: r['provider'] === 'linq' ? 'linq' : 'weave',
    idempotencyKey: String(r['idempotency_key']),
    currency: String(r['currency']),
    institutionCode: String(r['institution_code']),
    institutionName: String(r['institution_name']),
    accountIdentifier: String(r['account_identifier']),
    accountName: String(r['account_name']),
    depositAddress: String(r['deposit_address']),
    depositMemo: cleanMemo(r['deposit_memo']),
    amount: String(r['amount']),
    estimatedDest: String(r['estimated_dest']),
    paidDest: optional(r['paid_dest']),
    expiresAt:
      expires === null || expires === undefined
        ? undefined
        : new Date(expires as string | Date).toISOString(),
    status: String(r['status']) as WeaveStatus,
    providerStatus: String(r['provider_status']),
    depositHash: optional(r['deposit_hash']),
    sendStarted: r['send_started_at'] !== null && r['send_started_at'] !== undefined,
    createdAt: new Date(r['created_at'] as string | Date).toISOString(),
  }
}

export type NewWeaveOrder = Omit<WeaveOrderRow, 'createdAt' | 'depositHash' | 'sendStarted'>

export interface WeaveOrderRepo {
  ensureSchema: () => Promise<void>
  insert: (order: NewWeaveOrder) => Promise<void>
  /** Scoped by email: an order belongs to whoever made it. */
  getForEmail: (id: string, email: string) => Promise<WeaveOrderRow | undefined>
  getByIdempotencyKey: (key: string, email: string) => Promise<WeaveOrderRow | undefined>
  /**
   * The holder name Weave gave for an account this requester has already made an
   * order to, if recently. Scoped by email, so nobody can read another person's
   * lookups by guessing account numbers.
   */
  findHolder: (
    email: string,
    currency: string,
    institutionCode: string,
    accountIdentifier: string
  ) => Promise<string | undefined>
  /** This requester's orders, newest first. Never another's. */
  listForEmail: (email: string, limit: number) => Promise<WeaveOrderRow[]>
  /** Not scoped, because the webhook has no requester. Its signature is what admits it. */
  getByProviderOrder: (providerOrder: string) => Promise<WeaveOrderRow | undefined>
  setStatus: (providerOrder: string, status: WeaveStatus, providerStatus: string) => Promise<void>
  /** Records what a paid order paid out, once. */
  setPaid: (providerOrder: string, paidDest: string) => Promise<void>
  /**
   * `reused` when another order holds this hash, or this order holds a different
   * one. A wallet that sends for itself only hands over a hash, and an old one that
   * matches on account, address and amount would pass the chain's check again.
   */
  setDepositHash: (id: string, hash: string) => Promise<'stored' | 'reused'>
  /**
   * Takes the one right to send this order's deposit. False when a send has already
   * started. Atomic, so two submits arriving together cannot both send.
   */
  claimSend: (id: string) => Promise<boolean>
  /** Gives the right back, only for a send known not to have moved money. */
  releaseSend: (id: string) => Promise<void>
  /** Whether this wallet has a deposit on its way that Weave has not confirmed yet. */
  hasUnconfirmedSend: (account: string) => Promise<boolean>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNIQUE_VIOLATION = '23505'

export function createWeaveOrderRepo(query: QueryFn): WeaveOrderRepo {
  return {
    async ensureSchema() {
      for (const statement of WEAVE_DDL) await query(statement)
    },

    async insert(o) {
      await query(
        `INSERT INTO weave_orders
          (id, chain, email, account, provider_order, idempotency_key, currency, institution_code,
           institution_name, account_identifier, account_name, deposit_address, deposit_memo,
           amount, estimated_dest, expires_at, status, provider_status, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          o.id,
          o.chain,
          o.email,
          o.account,
          o.providerOrder,
          o.idempotencyKey,
          o.currency,
          o.institutionCode,
          o.institutionName,
          o.accountIdentifier,
          o.accountName,
          o.depositAddress,
          cleanMemo(o.depositMemo) ?? null,
          o.amount,
          o.estimatedDest,
          o.expiresAt ?? null,
          o.status,
          o.providerStatus,
          o.provider ?? 'weave',
        ]
      )
    },

    async getForEmail(id, email) {
      // The column is a uuid, and anything else would be a database error, not "not found".
      if (!UUID.test(id)) return undefined
      const { rows } = await query(`SELECT * FROM weave_orders WHERE id = $1 AND email = $2`, [
        id,
        email,
      ])
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async getByIdempotencyKey(key, email) {
      const { rows } = await query(
        `SELECT * FROM weave_orders WHERE idempotency_key = $1 AND email = $2`,
        [key, email]
      )
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async findHolder(email, currency, institutionCode, accountIdentifier) {
      const { rows } = await query(
        `SELECT account_name FROM weave_orders
          WHERE email = $1 AND currency = $2 AND institution_code = $3 AND account_identifier = $4
            AND created_at > now() - interval '30 days'
          ORDER BY created_at DESC LIMIT 1`,
        [email, currency, institutionCode, accountIdentifier]
      )
      const name = rows[0]?.['account_name']
      return typeof name === 'string' && name !== '' ? name : undefined
    },

    async listForEmail(email, limit) {
      const { rows } = await query(
        `SELECT * FROM weave_orders WHERE email = $1 ORDER BY created_at DESC LIMIT $2`,
        [email, limit]
      )
      return rows.map(fromDb)
    },

    async getByProviderOrder(providerOrder) {
      const { rows } = await query(`SELECT * FROM weave_orders WHERE provider_order = $1`, [
        providerOrder,
      ])
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async setPaid(providerOrder, paidDest) {
      await query(
        `UPDATE weave_orders SET paid_dest = $2, updated_at = now()
          WHERE provider_order = $1 AND status = 'paid' AND paid_dest IS NULL`,
        [providerOrder, paidDest]
      )
    },

    async setStatus(providerOrder, status, providerStatus) {
      // Held here as well as in `nextStatus`, because a webhook and a status read
      // can each decide from a row the other has since moved.
      await query(
        `UPDATE weave_orders
            SET status = $2, provider_status = $3, updated_at = now()
          WHERE provider_order = $1
            AND status NOT IN ('paid', 'failed', 'expired', 'refunded')
            AND NOT (status <> 'waiting' AND $2 = 'waiting')`,
        [providerOrder, status, providerStatus]
      )
    },

    async setDepositHash(id, hash) {
      try {
        const { rows } = await query(
          `UPDATE weave_orders SET deposit_hash = $2, updated_at = now()
            WHERE id = $1 AND (deposit_hash IS NULL OR deposit_hash = $2)
            RETURNING id`,
          [id, hash]
        )
        return rows[0] === undefined ? 'reused' : 'stored'
      } catch (e) {
        if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return 'reused'
        throw e
      }
    },

    async claimSend(id) {
      const { rows } = await query(
        `UPDATE weave_orders SET send_started_at = now(), updated_at = now()
          WHERE id = $1 AND send_started_at IS NULL AND deposit_hash IS NULL
          RETURNING id`,
        [id]
      )
      return rows[0] !== undefined
    },

    async releaseSend(id) {
      await query(
        `UPDATE weave_orders SET send_started_at = NULL, updated_at = now()
          WHERE id = $1 AND deposit_hash IS NULL`,
        [id]
      )
    },

    async hasUnconfirmedSend(account) {
      // Bounded by time as well as expiry, so an order Weave never reports on
      // cannot hold a wallet back for good.
      const { rows } = await query(
        `SELECT 1 FROM weave_orders
          WHERE account = $1 AND send_started_at IS NOT NULL AND status = 'waiting'
            AND created_at > now() - interval '24 hours'
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`,
        [account]
      )
      return rows[0] !== undefined
    },
  }
}

const globalForWeave = globalThis as unknown as { intentWeaveSchema?: Promise<void> }
const TIMEOUT_MS = 5_000

/** The production repository, over the shared pool; the table is created on first use. */
export async function getWeaveOrderRepo(): Promise<WeaveOrderRepo> {
  const pool = getPool()
  const repo = createWeaveOrderRepo(async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), TIMEOUT_MS)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForWeave.intentWeaveSchema === undefined) {
    globalForWeave.intentWeaveSchema = repo.ensureSchema().catch((e: unknown) => {
      delete globalForWeave.intentWeaveSchema
      throw e
    })
  }
  await globalForWeave.intentWeaveSchema
  return repo
}

export { MAX_COST_PERCENT } from './types'

function canonicalDecimal(text: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match === null) return undefined
  const whole = (match[1] as string).replace(/^0+(?=\d)/, '')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** An amount as text a chain can pay exactly, or nothing. Never rounded, never exponent notation. */
export function readUsdcAmount(text: string, decimals: number): string | undefined {
  const amount = canonicalDecimal(text)
  if (amount === undefined || amount === '0') return undefined
  const places = amount.split('.')[1]?.length ?? 0
  return places > decimals ? undefined : amount
}

/**
 * Weave adds its costs on top of the amount asked for: 5 USDC came back live as a
 * deposit of 5.05322. So the deposit may run a little over, and never under, what
 * the person asked to send. Whatever it is, they see it before they sign.
 */
const MAX_DEPOSIT_OVER_PERCENT = 2
const SCALE_PLACES = 18

function scaled(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.')
  return BigInt(whole + fraction.padEnd(SCALE_PLACES, '0'))
}

function isFairDeposit(deposit: string, asked: string, decimals: number): boolean {
  const paid = readUsdcAmount(deposit, decimals)
  const wanted = canonicalDecimal(asked)
  if (paid === undefined || wanted === undefined) return false
  const most = (scaled(wanted) * BigInt(100 + MAX_DEPOSIT_OVER_PERCENT)) / BigInt(100)
  return scaled(paid) >= scaled(wanted) && scaled(paid) <= most
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Which part of Weave's answer differs from what was asked, or nothing. This runs
 * before an order is stored or shown, because the address and amount it returns
 * are what a person will pay: wrong chain, wrong asset or a malformed address all
 * mean funds that cannot be recovered.
 */
export function orderMismatch(
  order: WeaveOrder,
  asked: { chain: CashoutChain; currency: string; amount: string },
  deposit: Pick<DepositChain, 'isDepositAddress' | 'supportsMemo' | 'usdcDecimals'>
): string | undefined {
  if (!sameName(order.deposit.chain, weaveChainId(asked.chain))) return 'chain'
  if (!sameName(order.deposit.token, 'USDC')) return 'token'
  if (!isFairDeposit(order.deposit.amount.trim(), asked.amount, deposit.usdcDecimals)) {
    return 'amount'
  }
  if (!deposit.isDepositAddress(order.deposit.address)) return 'address'
  if (cleanMemo(order.deposit.memo) !== undefined && !deposit.supportsMemo) return 'memo'
  if (
    order.sourceAssetKey !== undefined &&
    !sameName(order.sourceAssetKey, weaveAssetKey(asked.chain))
  ) {
    return 'source_asset'
  }
  if (order.destAssetKey !== undefined && !sameName(order.destAssetKey, `fiat:${asked.currency}`)) {
    return 'dest_asset'
  }
  return undefined
}

export interface SyncedOrder {
  row: WeaveOrderRow
  /** False when Weave could not be asked or its answer could not be read. */
  reached: boolean
}

/**
 * Asks Weave where an order stands and records it. The stored status is only the
 * last thing this app was told, and a webhook can be missed. What an order expects is never
 * written back: it is what it was made for. What a paid order paid out is kept beside it.
 */
/** An order's live status and paid amount, from whichever provider holds it. */
async function readLive(
  row: WeaveOrderRow,
  weave: Pick<WeaveClient, 'getOrder'>,
  linq: Pick<LinqClient, 'getStatus'> | undefined
): Promise<
  { ok: true; value: { status: string; destAmount?: number | undefined } } | { ok: false }
> {
  if (row.provider !== 'linq') return weave.getOrder(row.providerOrder)
  if (linq === undefined) return { ok: false }
  const res = await linq.getStatus(row.providerOrder)
  if (!res.ok) return { ok: false }
  // Linq states the naira when the order is made and pays exactly that.
  const naira = res.value.amountNGN
  return {
    ok: true,
    value: { status: res.value.status, ...(naira > 0 ? { destAmount: naira } : {}) },
  }
}

export async function syncOrder(
  repo: Pick<WeaveOrderRepo, 'setStatus' | 'setPaid'>,
  row: WeaveOrderRow,
  weave: Pick<WeaveClient, 'getOrder'>,
  linq?: Pick<LinqClient, 'getStatus'>
): Promise<SyncedOrder> {
  // A paid order is asked once more for what it paid out, which a webhook does not carry.
  const paidUnread = row.status === 'paid' && row.paidDest === undefined
  if (isFinal(row.status) && !paidUnread) return { row, reached: true }
  const live = await readLive(row, weave, linq)
  if (!live.ok) return { row, reached: false }
  const status =
    row.provider === 'linq'
      ? nextLinqStatus(
          row.status,
          live.value.status,
          row.depositHash !== undefined || row.sendStarted
        )
      : nextStatus(row.status, live.value.status)
  if (status !== row.status || live.value.status !== row.providerStatus) {
    await repo.setStatus(row.providerOrder, status, live.value.status)
  }
  const paid =
    status === 'paid' && live.value.destAmount !== undefined && row.paidDest === undefined
      ? String(live.value.destAmount)
      : undefined
  if (paid !== undefined) await repo.setPaid(row.providerOrder, paid)
  return {
    row: {
      ...row,
      status,
      providerStatus: live.value.status,
      ...(paid !== undefined ? { paidDest: paid } : {}),
    },
    reached: true,
  }
}

export function isPastExpiry(row: WeaveOrderRow, now: number = Date.now()): boolean {
  return row.expiresAt !== undefined && Date.parse(row.expiresAt) <= now
}

export interface PayRefusal {
  code: 'unconfirmed' | 'not_payable'
  status: 503 | 409
  /** Says why, without saying what was or was not sent: the two routes differ on that. */
  reason: string
}

/**
 * Why an order may not be paid now, or nothing. A deposit is only ever built for
 * a status Weave has positively said is waiting. If it could not be asked, or used
 * a word this app does not know, the order stays `waiting` in the record but is
 * not paid: paying into an order that already has its deposit would be paying twice.
 */
export function payRefusal(synced: SyncedOrder, now: number = Date.now()): PayRefusal | undefined {
  const { row, reached } = synced
  if (row.depositHash !== undefined) {
    return {
      code: 'not_payable',
      status: 409,
      reason: 'This cash-out has already had its deposit.',
    }
  }
  if (row.status !== 'waiting') {
    return {
      code: 'not_payable',
      status: 409,
      reason: `This cash-out is no longer waiting for a deposit (${row.status}).`,
    }
  }
  if (isPastExpiry(row, now)) {
    return {
      code: 'not_payable',
      status: 409,
      reason: 'This cash-out has expired. Review it again to start a new one.',
    }
  }
  if (!reached || mapProviderStatus(row.providerStatus) !== 'waiting') {
    return {
      code: 'unconfirmed',
      status: 503,
      reason:
        'Could not confirm that this cash-out is still waiting for a deposit. Try again in a moment.',
    }
  }
  return undefined
}

/** What the deposit must be, read from the stored order and never from the browser. */
export function depositExpectation(row: WeaveOrderRow): DepositExpectation {
  return {
    account: row.account,
    depositAddress: row.depositAddress,
    memo: cleanMemo(row.depositMemo),
    amount: row.amount,
  }
}

/**
 * An error as it may be reported. A thrower writes whatever it likes into a
 * message, and the account digits, holder name and memo must not reach a log.
 */
export function safeForReport(
  error: unknown,
  row: Pick<WeaveOrderRow, 'accountIdentifier' | 'accountName' | 'depositMemo'>
): Error {
  const scrub = (text: string): string =>
    [row.accountIdentifier, row.accountName, row.depositMemo].reduce<string>(
      (out, value) =>
        value === undefined || value === '' ? out : out.split(value).join('[redacted]'),
      text
    )
  const clean = new Error(scrub(error instanceof Error ? error.message : String(error)))
  if (error instanceof Error) {
    clean.name = error.name
    if (error.stack !== undefined) clean.stack = scrub(error.stack)
  }
  return clean
}
