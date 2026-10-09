import { Pool } from 'pg'

import { SEED_PREFIX, buildSeed } from '../lib/dev/seed-analytics'
import { ANALYTICS_DDL } from '../lib/server/analytics'

/**
 * Fills a local database with made-up usage so the admin dashboard has something
 * to show, and removes it again.
 *
 *   pnpm analytics:seed                      60 days on testnet
 *   pnpm analytics:seed --network mainnet    the same, on mainnet's numbers
 *   pnpm analytics:seed --days 30
 *   pnpm analytics:seed --clear              remove every seeded row
 *
 * Refuses any database that is not on this machine, and marks every row it writes
 * so --clear takes out exactly those and nothing else. The default is testnet so
 * real mainnet numbers are never mixed with invented ones.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. Run `docker compose up -d` and check .env.local')
    process.exit(1)
  }
  const host = new URL(url).hostname
  if (!LOCAL.has(host)) {
    console.error(`Refusing to seed ${host}: this only writes to a database on this machine.`)
    process.exit(1)
  }

  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    for (const statement of ANALYTICS_DDL) await pool.query(statement)

    if (process.argv.includes('--clear')) {
      const like = `${SEED_PREFIX}%`
      await pool.query(`DELETE FROM agent_proposals WHERE race_id::text LIKE $1`, [like])
      const counts = [
        [
          'usage_executions',
          await pool.query(`DELETE FROM usage_executions WHERE id::text LIKE $1`, [like]),
        ],
        ['agent_races', await pool.query(`DELETE FROM agent_races WHERE id::text LIKE $1`, [like])],
        [
          'intent_reads',
          await pool.query(`DELETE FROM intent_reads WHERE id::text LIKE $1`, [like]),
        ],
      ] as const
      for (const [table, result] of counts)
        console.log(`removed ${result.rowCount ?? 0} from ${table}`)
      return
    }

    const network = arg('network') ?? 'testnet'
    if (network !== 'testnet' && network !== 'mainnet') {
      console.error('--network must be testnet or mainnet')
      process.exit(1)
    }
    const days = Math.min(Math.max(Number(arg('days') ?? 60) || 60, 1), 365)
    const seed = buildSeed({ network, days, now: new Date() })

    for (const e of seed.executions) {
      await pool.query(
        `INSERT INTO usage_executions
           (id, network, hash, account, kind, fee_sponsored, ok, failure, submitted_at,
            asset_in, asset_out, amount_in, volume_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING`,
        [
          e.id,
          e.network,
          e.hash,
          e.account,
          e.kind,
          e.feeSponsored,
          e.ok,
          e.failure,
          e.at.toISOString(),
          e.assetIn,
          e.assetOut,
          e.amountIn,
          e.volumeUsd,
        ]
      )
    }
    for (const r of seed.races) {
      await pool.query(
        `INSERT INTO agent_races
           (id, network, started_at, intent_type, token_in, token_out, size_usd, agents, answered,
            winner, unanimous, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, 'XLM', 'USDC', $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`,
        [
          r.id,
          r.network,
          r.at.toISOString(),
          r.intentType,
          r.sizeUsd,
          r.agents,
          r.answered,
          r.winner,
          r.unanimous,
          r.outcome,
          r.durationMs,
        ]
      )
      for (const p of r.proposals) {
        await pool.query(
          `INSERT INTO agent_proposals (race_id, agent, model, ok, failure, latency_ms, score, won)
           VALUES ($1, $2, 'seed', $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [r.id, p.agent, p.ok, p.failure, p.latencyMs, p.score, p.won]
        )
      }
    }
    for (const x of seed.reads) {
      await pool.query(
        `INSERT INTO intent_reads
           (id, network, read_at, understood, action, token_in, token_out, size_usd, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          x.id,
          x.network,
          x.at.toISOString(),
          x.understood,
          x.action,
          x.tokenIn,
          x.tokenOut,
          x.sizeUsd,
          x.reason,
        ]
      )
    }
    console.log(
      `seeded ${network}, ${days} days: ${seed.executions.length} transactions, ` +
        `${seed.races.length} races, ${seed.reads.length} intent reads. ` +
        'Remove them with `pnpm analytics:seed --clear`.'
    )
  } finally {
    await pool.end()
  }
}

void main()
