import { activeNetwork, defaultNetwork, type StellarNetworkName } from '@intent/config'

import { getPool, withTimeout, type QueryFn } from './db'

/**
 * What the fee sponsor has committed today.
 *
 * One row per account per day, and a `*` row for the day as a whole, both
 * bumped by the same statement so they cannot drift. The budget check in
 * `sponsorForSubmission` reads the two in one query and decides; nothing
 * here decides anything.
 *
 * Takes a query function rather than the pool, like the standing-rules
 * repository, so the unit tests run it over an in-memory fake.
 * `getSponsorLedger` is the production wiring.
 */

export interface DayUsage {
  /** Stroops committed today, across every account. */
  totalStroops: bigint
  totalCount: number
  /** This account's share, when one was named; zero otherwise. */
  accountStroops: bigint
  accountCount: number
}

export interface SponsorLedger {
  ensureSchema: () => Promise<void>
  usage: (day: string, account?: string) => Promise<DayUsage>
  /** Adds a fee to the account and the day, answering with both as written. */
  record: (day: string, account: string, stroops: bigint) => Promise<DayUsage>
  /** Takes a `record` back, when what it reserved turned out not to fit. */
  release: (day: string, account: string, stroops: bigint) => Promise<void>
}

/**
 * The table, as the migration file also states it. Duplicated for the same
 * reason as `STANDING_RULES_DDL`: the migration runs only at first container
 * init, and this runs on first use. Keep the two in sync.
 */
export const SPONSOR_LEDGER_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sponsor_ledger (
    day      DATE    NOT NULL,
    account  TEXT    NOT NULL,
    stroops  BIGINT  NOT NULL DEFAULT 0,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, account)
  )`,
]

/** The account the day as a whole is counted under. */
const EVERYONE = '*'

/** The account row and the day's total row, in either order, as one usage. */
function toUsage(rows: Record<string, unknown>[], everyone: string): DayUsage {
  const usage: DayUsage = {
    totalStroops: BigInt(0),
    totalCount: 0,
    accountStroops: BigInt(0),
    accountCount: 0,
  }
  for (const row of rows) {
    // BIGINT comes back from pg as a string.
    const stroops = BigInt(String(row['stroops']))
    const count = Number(row['count'])
    if (row['account'] === everyone) {
      usage.totalStroops = stroops
      usage.totalCount = count
    } else {
      usage.accountStroops = stroops
      usage.accountCount = count
    }
  }
  return usage
}

/**
 * `scope` names a network whose spend is kept apart from the rest. Its rows
 * carry the network in their key (`mainnet:G…`, `mainnet:*`), so one table
 * holds every network's day without a schema change, and a network's total,
 * budget and releases never touch another's. Without a scope the keys are the
 * plain ones every row written before there were two networks already has.
 */
export function createSponsorLedger(query: QueryFn, scope?: StellarNetworkName): SponsorLedger {
  const keyed = (account: string): string => (scope === undefined ? account : `${scope}:${account}`)
  const everyone = keyed(EVERYONE)

  return {
    async ensureSchema() {
      for (const statement of SPONSOR_LEDGER_DDL) await query(statement)
    },

    async usage(day, account) {
      const { rows } = await query(
        `SELECT account, stroops, count FROM sponsor_ledger
         WHERE day = $1 AND account = ANY($2::text[])`,
        [day, account === undefined ? [everyone] : [keyed(account), everyone]]
      )
      return toUsage(rows, everyone)
    },

    async record(day, account, stroops) {
      // Both rows in one statement, so a failure between them cannot leave
      // the day's total behind its accounts. RETURNING carries them back as
      // written, which is what lets the budget be judged after reserving:
      // two submissions racing for the last of it each see the total their
      // own write produced, and the one that went over gives it back.
      const { rows } = await query(
        `INSERT INTO sponsor_ledger (day, account, stroops, count)
         VALUES ($1, $2, $3, 1), ($1, $4, $3, 1)
         ON CONFLICT (day, account) DO UPDATE
           SET stroops = sponsor_ledger.stroops + EXCLUDED.stroops,
               count = sponsor_ledger.count + 1
         RETURNING account, stroops, count`,
        [day, keyed(account), stroops.toString(), everyone]
      )
      return toUsage(rows, everyone)
    },

    async release(day, account, stroops) {
      await query(
        `UPDATE sponsor_ledger
         SET stroops = sponsor_ledger.stroops - $3, count = sponsor_ledger.count - 1
         WHERE day = $1 AND account IN ($2, $4)`,
        [day, keyed(account), stroops.toString(), everyone]
      )
    },
  }
}

/**
 * The production ledger, over the shared pool. Every statement is bounded
 * so a database that hangs holds a submission for this long per statement
 * and no longer; the caller treats the timeout like any other failure.
 */
const LEDGER_TIMEOUT_MS = 2_000

const globalForLedger = globalThis as unknown as { intentSponsorLedgerSchema?: Promise<void> }

export async function getSponsorLedger(
  network: StellarNetworkName = activeNetwork()
): Promise<SponsorLedger> {
  const pool = getPool()
  // The deployment's default network keeps the plain keys, so the history a
  // single-network deployment already has stays its own.
  const ledger = createSponsorLedger(
    async (sql, params) => {
      const result = await withTimeout(pool.query(sql, params), LEDGER_TIMEOUT_MS)
      return { rows: result.rows as Record<string, unknown>[] }
    },
    network === defaultNetwork() ? undefined : network
  )

  if (globalForLedger.intentSponsorLedgerSchema === undefined) {
    globalForLedger.intentSponsorLedgerSchema = ledger.ensureSchema().catch((e: unknown) => {
      // A failed attempt must not be cached as success, or every later call
      // would skip the DDL and fail on a missing table.
      delete globalForLedger.intentSponsorLedgerSchema
      throw e
    })
  }
  await globalForLedger.intentSponsorLedgerSchema

  return ledger
}
