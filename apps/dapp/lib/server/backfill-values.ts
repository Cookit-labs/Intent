import { LOGGED_KIND } from '../chains/receipt'
import { chainModule } from '../chains/registry'
import type { ChainToken, ChainWithActions } from '../chains/types'
import { describeMovement, NotFound, readMovement, type Movement } from './chain-lookup'
import { databaseConfigured, getPool, withTimeout, type QueryFn } from './db'
import { reportError } from './report'

/**
 * Values the transactions on other chains that were logged before submit recorded what they
 * sold. Each is read back from its chain by hash, priced at today's price (no history is kept
 * for every token), and marked as looked up, so it is never read twice. One that its chain has
 * no record of, or that sold nothing this app can price, is marked and keeps no value. One whose
 * chain did not answer is left to try again.
 *
 * Runs by itself, a batch at a time after the admin overview is read, until none are left.
 */

const CHAINS = ['solana', 'sui', 'near', 'avalanche', 'monad'] as const

// 'unreadable' was also written when a node refused to answer, which says nothing about the
// transaction, so rows marked that way are read again; a real miss is now 'not_found'.
const OPEN = `(e.looked_up IS NULL OR e.looked_up = 'unreadable')`
const PENDING = `e.chain = ANY($1) AND e.ok AND e.hash IS NOT NULL AND e.kind = 'unknown'
  AND e.volume_usd IS NULL AND ${OPEN}`

export interface BackfillReport {
  looked: number
  valued: number
  unreadable: number
  /** Lookups that failed on the network this time, left to try again. */
  retry: number
  remaining: number
}

export interface BackfillDeps {
  /** Throws NotFound when the chain has no such transaction, anything else to try again later. */
  read: (chain: ChainWithActions, hash: string, account: string) => Promise<Movement>
  tokens: (chain: ChainWithActions) => readonly ChainToken[]
  price: (chain: ChainWithActions, token: ChainToken) => Promise<number | undefined>
}

const liveDeps: BackfillDeps = {
  read: readMovement,
  tokens: (chain) => chainModule(chain)?.tokens ?? [],
  price: async (chain, token) => chainModule(chain)?.priceUsd(token),
}

/** How a race's intent is counted, when the transaction followed one. */
function raceKind(type: unknown): string | undefined {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(LOGGED_KIND, type)
    ? LOGGED_KIND[type as keyof typeof LOGGED_KIND]
    : undefined
}

export async function remainingToValue(query: QueryFn): Promise<number> {
  const { rows } = await query(`SELECT count(*) AS n FROM usage_executions e WHERE ${PENDING}`, [
    [...CHAINS],
  ])
  return Number(rows[0]?.['n'] ?? 0)
}

export async function backfillBatch(
  query: QueryFn,
  deps: BackfillDeps = liveDeps,
  limit = 15,
  budgetMs = 40_000
): Promise<BackfillReport> {
  const started = Date.now()
  const { rows } = await query(
    `SELECT e.id, e.chain, e.hash, e.account, r.intent_type
     FROM usage_executions e LEFT JOIN agent_races r ON r.id = e.race_id
     WHERE ${PENDING}
     ORDER BY e.submitted_at LIMIT $2`,
    [[...CHAINS], limit]
  )
  const prices = new Map<string, Promise<number | undefined>>()
  const report: BackfillReport = { looked: 0, valued: 0, unreadable: 0, retry: 0, remaining: 0 }

  for (const row of rows) {
    if (Date.now() - started > budgetMs) break
    const chain = String(row['chain']) as ChainWithActions
    const id = String(row['id'])
    report.looked += 1
    let movement: Movement | undefined
    try {
      movement = await deps.read(chain, String(row['hash']), String(row['account']))
    } catch (e) {
      if (!(e instanceof NotFound)) {
        report.retry += 1
        continue
      }
    }
    const found =
      movement === undefined ? undefined : describeMovement(chain, deps.tokens(chain), movement)
    if (found === undefined) {
      await query(`UPDATE usage_executions e SET looked_up = $2 WHERE e.id = $1 AND ${OPEN}`, [
        id,
        movement === undefined ? 'not_found' : 'no_value',
      ])
      report.unreadable += 1
      continue
    }
    const key = `${chain}|${found.token.id}`
    if (!prices.has(key))
      prices.set(
        key,
        deps.price(chain, found.token).catch(() => undefined)
      )
    const price = await prices.get(key)
    const usd = price === undefined ? null : Math.round(Number(found.amountIn) * price * 100) / 100
    await query(
      `UPDATE usage_executions e
       SET kind = $2, asset_in = $3, asset_out = $4, amount_in = $5, volume_usd = $6,
           looked_up = 'chain'
       WHERE e.id = $1 AND ${OPEN}`,
      [
        id,
        raceKind(row['intent_type']) ?? found.kind,
        found.token.symbol,
        found.assetOut,
        found.amountIn,
        usd,
      ]
    )
    if (usd !== null) report.valued += 1
  }

  report.remaining = await remainingToValue(query)
  return report
}

const globalForBackfill = globalThis as unknown as { intentBackfill?: Promise<void> }

/**
 * One batch, unless one is already running on this instance. Never throws: it runs after the
 * admin's answer has gone, and a failure is only reported, for the next read to try again.
 */
export function valuePastTransactions(): Promise<void> {
  if (!databaseConfigured()) return Promise.resolve()
  if (globalForBackfill.intentBackfill !== undefined) return globalForBackfill.intentBackfill
  const pool = getPool()
  const query: QueryFn = async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), 8_000)
    return { rows: result.rows as Record<string, unknown>[] }
  }
  globalForBackfill.intentBackfill = (async () => {
    try {
      if ((await remainingToValue(query)) > 0) await backfillBatch(query)
    } catch (e) {
      reportError('admin/backfill', e)
    } finally {
      delete globalForBackfill.intentBackfill
    }
  })()
  return globalForBackfill.intentBackfill
}
