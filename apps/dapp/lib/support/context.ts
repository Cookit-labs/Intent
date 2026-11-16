import { promptSafe } from '../agents/prompt-safe'
import { orderNetwork } from '../naira/orders'
import { getPool, type QueryFn } from '../server/db'
import { getWeaveOrderRepo, type WeaveOrderRow } from '../weave/orders'
import type { OrderSnapshot } from './tickets'

/**
 * The person's recent off-ramp orders, read only, for the assistant and for a ticket.
 *
 * What leaves here carries no bank account number or holder name: the assistant does not need them
 * to say where an order stands, and a ticket is read by people other than the person.
 */

const RECENT = 5

export function snapshotOfOffRamp(row: WeaveOrderRow): OrderSnapshot {
  return {
    id: row.id,
    kind: 'offramp',
    chain: row.chain,
    provider: row.provider ?? 'weave',
    status: row.status,
    providerStatus: row.providerStatus,
    amount: row.amount,
    coin: 'USDC',
    payout: row.paidDest ?? row.estimatedDest,
    currency: row.currency,
    depositSent: row.depositHash !== undefined || row.sendStarted,
    createdAt: row.createdAt,
  }
}

export function snapshotOfNaira(r: Record<string, unknown>): OrderSnapshot {
  return {
    id: String(r['id']),
    kind: 'naira',
    chain: 'stellar',
    provider: 'linq',
    status: String(r['status']),
    providerStatus: String(r['provider_status']),
    amount: String(r['amount_xlm']),
    coin: r['coin'] === 'usdc' ? 'USDC' : 'XLM',
    payout: String(r['amount_ngn']),
    currency: 'NGN',
    depositSent: r['payment_hash'] !== null && r['payment_hash'] !== undefined,
    createdAt: new Date(String(r['created_at'])).toISOString(),
  }
}

export interface ContextSources {
  offRamps: (requester: string, limit: number) => Promise<WeaveOrderRow[]>
  naira: (requester: string, limit: number) => Promise<Record<string, unknown>[]>
}

function nairaQuery(query: QueryFn): ContextSources['naira'] {
  return async (requester, limit) => {
    const { rows } = await query(
      `SELECT id, status, provider_status, amount_xlm, amount_ngn, coin, payment_hash, created_at
         FROM naira_orders WHERE email = $1 AND network = $2
        ORDER BY created_at DESC LIMIT $3`,
      [requester, orderNetwork(), limit]
    )
    return rows
  }
}

export function productionSources(): ContextSources {
  const pool = getPool()
  return {
    offRamps: async (requester, limit) =>
      (await getWeaveOrderRepo()).listForEmail(requester, limit),
    naira: nairaQuery(async (sql, params) => {
      try {
        const result = await pool.query(sql, params)
        return { rows: result.rows as Record<string, unknown>[] }
      } catch {
        // No naira order was ever made on this database, so the table does not exist yet.
        return { rows: [] }
      }
    }),
  }
}

/** The newest orders across both stores, newest first. A store that fails adds nothing. */
export async function recentOrders(
  requester: string,
  sources: ContextSources = productionSources()
): Promise<OrderSnapshot[]> {
  const [offRamps, naira] = await Promise.all([
    sources.offRamps(requester, RECENT).catch(() => []),
    sources.naira(requester, RECENT).catch(() => []),
  ])
  return [...offRamps.map(snapshotOfOffRamp), ...naira.map(snapshotOfNaira)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT)
}

/** The orders as lines of data for the model. Every value is one bounded line. */
export function ordersForPrompt(orders: OrderSnapshot[], now: number = Date.now()): string {
  if (orders.length === 0) return 'No off-ramp orders on record for this person.'
  return orders
    .map((o) => {
      const minutes = Math.max(0, Math.round((now - new Date(o.createdAt).getTime()) / 60_000))
      return [
        `order ${promptSafe(o.id, 40)}`,
        `chain ${promptSafe(o.chain, 16)}`,
        `paid out by ${promptSafe(o.provider, 16)}`,
        `status ${promptSafe(o.status, 16)}`,
        `provider says "${promptSafe(o.providerStatus, 60)}"`,
        `${promptSafe(o.amount, 24)} ${promptSafe(o.coin, 8)} for ${promptSafe(o.payout, 24)} ${promptSafe(o.currency, 8)}`,
        o.depositSent ? 'deposit sent from wallet' : 'no deposit sent yet',
        `made ${minutes} minutes ago`,
      ].join(', ')
    })
    .join('\n')
}
