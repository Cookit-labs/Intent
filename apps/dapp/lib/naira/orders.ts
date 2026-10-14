import { activeNetwork } from '@intent/config'

import { getPool, withTimeout, type QueryFn } from '../server/db'
import type { NairaCoin } from './build-payment'
import type { NairaStatus } from './status'

/**
 * Naira payout orders, one row each.
 *
 * The bank account number is stored here because the payout and support need
 * it, and nowhere else: it is not written to chat history, logs or analytics,
 * and `toPublic` below is the only shape that leaves the server.
 */

export const NAIRA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS naira_orders (
    id              UUID        PRIMARY KEY,
    network         TEXT        NOT NULL,
    email           TEXT        NOT NULL,
    account         TEXT        NOT NULL,
    provider_order  TEXT        NOT NULL UNIQUE,
    idempotency_key TEXT        NOT NULL UNIQUE,
    bank_code       TEXT        NOT NULL,
    bank_name       TEXT        NOT NULL,
    account_number  TEXT        NOT NULL,
    account_name    TEXT        NOT NULL,
    deposit_address TEXT        NOT NULL,
    amount_xlm      NUMERIC     NOT NULL,
    amount_ngn      NUMERIC     NOT NULL,
    rate            NUMERIC     NOT NULL,
    status          TEXT        NOT NULL,
    provider_status TEXT        NOT NULL,
    payment_hash    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS naira_orders_email_idx ON naira_orders (email, created_at)`,
  // Which asset the deposit is in. \`amount_xlm\` keeps its name and holds the
  // amount of this asset; a rename is deferred.
  `ALTER TABLE naira_orders ADD COLUMN IF NOT EXISTS coin TEXT NOT NULL DEFAULT 'xlm'`,
]

export interface NairaOrderRow {
  id: string
  network: string
  email: string
  account: string
  providerOrder: string
  idempotencyKey: string
  bankCode: string
  bankName: string
  accountNumber: string
  accountName: string
  depositAddress: string
  coin: NairaCoin
  /** Amount of `coin` the deposit must be, display units. */
  amount: string
  amountNgn: string
  rate: string
  status: NairaStatus
  providerStatus: string
  paymentHash: string | undefined
  createdAt: string
}

/** What the browser is allowed to see: the account number is masked. */
export interface NairaOrderView {
  id: string
  status: NairaStatus
  depositAddress: string
  coin: NairaCoin
  amount: string
  amountNgn: string
  rate: string
  bankName: string
  accountName: string
  accountMask: string
  paymentHash: string | undefined
}

export function toPublic(row: NairaOrderRow): NairaOrderView {
  return {
    id: row.id,
    status: row.status,
    depositAddress: row.depositAddress,
    coin: row.coin,
    amount: row.amount,
    amountNgn: row.amountNgn,
    rate: row.rate,
    bankName: row.bankName,
    accountName: row.accountName,
    accountMask: `••••${row.accountNumber.slice(-4)}`,
    paymentHash: row.paymentHash,
  }
}

function fromDb(r: Record<string, unknown>): NairaOrderRow {
  return {
    id: String(r['id']),
    network: String(r['network']),
    email: String(r['email']),
    account: String(r['account']),
    providerOrder: String(r['provider_order']),
    idempotencyKey: String(r['idempotency_key']),
    bankCode: String(r['bank_code']),
    bankName: String(r['bank_name']),
    accountNumber: String(r['account_number']),
    accountName: String(r['account_name']),
    depositAddress: String(r['deposit_address']),
    coin: r['coin'] === 'usdc' ? 'usdc' : 'xlm',
    amount: String(r['amount_xlm']),
    amountNgn: String(r['amount_ngn']),
    rate: String(r['rate']),
    status: String(r['status']) as NairaStatus,
    providerStatus: String(r['provider_status']),
    paymentHash: r['payment_hash'] === null ? undefined : String(r['payment_hash']),
    createdAt: new Date(String(r['created_at'])).toISOString(),
  }
}

export type NewNairaOrder = Omit<NairaOrderRow, 'createdAt' | 'paymentHash'>

export interface NairaOrderRepo {
  ensureSchema: () => Promise<void>
  insert: (order: NewNairaOrder) => Promise<void>
  /** Scoped by email: an order belongs to whoever was signed in when it was made. */
  getForEmail: (id: string, email: string) => Promise<NairaOrderRow | undefined>
  getByIdempotencyKey: (key: string, email: string) => Promise<NairaOrderRow | undefined>
  getByProviderOrder: (providerOrder: string) => Promise<NairaOrderRow | undefined>
  setStatus: (
    providerOrder: string,
    status: NairaStatus,
    providerStatus: string,
    settled?: { amountCoin: number; amountNgn: number }
  ) => Promise<void>
  setPaymentHash: (id: string, hash: string) => Promise<void>
}

export function createNairaOrderRepo(query: QueryFn): NairaOrderRepo {
  return {
    async ensureSchema() {
      for (const statement of NAIRA_DDL) await query(statement)
    },

    async insert(o) {
      await query(
        `INSERT INTO naira_orders
          (id, network, email, account, provider_order, idempotency_key, bank_code, bank_name,
           account_number, account_name, deposit_address, amount_xlm, amount_ngn, rate, status,
           provider_status, coin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          o.id,
          o.network,
          o.email,
          o.account,
          o.providerOrder,
          o.idempotencyKey,
          o.bankCode,
          o.bankName,
          o.accountNumber,
          o.accountName,
          o.depositAddress,
          o.amount,
          o.amountNgn,
          o.rate,
          o.status,
          o.providerStatus,
          o.coin,
        ]
      )
    },

    async getForEmail(id, email) {
      const { rows } = await query(`SELECT * FROM naira_orders WHERE id = $1 AND email = $2`, [
        id,
        email,
      ])
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async getByIdempotencyKey(key, email) {
      const { rows } = await query(
        `SELECT * FROM naira_orders WHERE idempotency_key = $1 AND email = $2`,
        [key, email]
      )
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async getByProviderOrder(providerOrder) {
      const { rows } = await query(`SELECT * FROM naira_orders WHERE provider_order = $1`, [
        providerOrder,
      ])
      const row = rows[0]
      return row === undefined ? undefined : fromDb(row)
    },

    async setStatus(providerOrder, status, providerStatus, settled) {
      // A terminal status is never overwritten by a late, out-of-order event.
      await query(
        `UPDATE naira_orders
            SET status = $2, provider_status = $3,
                amount_xlm = COALESCE($4::numeric, amount_xlm),
                amount_ngn = COALESCE($5::numeric, amount_ngn),
                updated_at = now()
          WHERE provider_order = $1 AND status NOT IN ('paid', 'expired', 'failed')`,
        [
          providerOrder,
          status,
          providerStatus,
          settled !== undefined && settled.amountCoin > 0 ? settled.amountCoin : null,
          settled !== undefined && settled.amountNgn > 0 ? settled.amountNgn : null,
        ]
      )
    },

    async setPaymentHash(id, hash) {
      await query(`UPDATE naira_orders SET payment_hash = $2, updated_at = now() WHERE id = $1`, [
        id,
        hash,
      ])
    },
  }
}

const globalForNaira = globalThis as unknown as { intentNairaSchema?: Promise<void> }
const TIMEOUT_MS = 5_000

/** The production repository, over the shared pool; the table is created on first use. */
export async function getNairaOrderRepo(): Promise<NairaOrderRepo> {
  const pool = getPool()
  const repo = createNairaOrderRepo(async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), TIMEOUT_MS)
    return { rows: result.rows as Record<string, unknown>[] }
  })

  if (globalForNaira.intentNairaSchema === undefined) {
    globalForNaira.intentNairaSchema = repo.ensureSchema().catch((e: unknown) => {
      delete globalForNaira.intentNairaSchema
      throw e
    })
  }
  await globalForNaira.intentNairaSchema
  return repo
}

/** The network a new order is recorded for. */
export function orderNetwork(): string {
  return activeNetwork()
}
