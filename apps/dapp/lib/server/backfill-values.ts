import { LOGGED_KIND } from '../chains/receipt'
import { chainModule } from '../chains/registry'
import type { ChainToken, ChainWithActions } from '../chains/types'
import { describeMovement, readMovement, type Movement } from './chain-lookup'
import type { QueryFn } from './db'

/**
 * Values the transactions on other chains that were logged before submit recorded what they
 * sold. Each is read back from its chain by hash, priced at today's price (no history is kept
 * for every token), and marked as looked up, so it is never read twice. One that its chain has
 * no record of, or that sold nothing this app can price, is marked unreadable and keeps no value.
 *
 * Run from the admin, a batch at a time, because each lookup is a call to a public node.
 */

const CHAINS = ['solana', 'sui', 'near', 'avalanche', 'monad'] as const

const PENDING = `e.chain = ANY($1) AND e.ok AND e.hash IS NOT NULL AND e.kind = 'unknown'
  AND e.volume_usd IS NULL AND e.looked_up IS NULL`

export interface BackfillReport {
  looked: number
  valued: number
  unreadable: number
  /** Lookups that failed on the network this time, left to try again. */
  retry: number
  remaining: number
}

export interface BackfillDeps {
  read: (chain: ChainWithActions, hash: string, account: string) => Promise<Movement | undefined>
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
    } catch {
      report.retry += 1
      continue
    }
    const found =
      movement === undefined ? undefined : describeMovement(chain, deps.tokens(chain), movement)
    if (found === undefined) {
      await query(
        `UPDATE usage_executions SET looked_up = 'unreadable' WHERE id = $1 AND looked_up IS NULL`,
        [id]
      )
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
      `UPDATE usage_executions
       SET kind = $2, asset_in = $3, asset_out = $4, amount_in = $5, volume_usd = $6,
           looked_up = 'chain'
       WHERE id = $1 AND looked_up IS NULL`,
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
