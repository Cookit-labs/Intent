import { NextResponse } from 'next/server'

import { isAdminRequest } from '../../../../lib/server/admin-session'
import { getAnalyticsRepo } from '../../../../lib/server/analytics'
import { backfillBatch, remainingToValue } from '../../../../lib/server/backfill-values'
import { databaseConfigured, getPool, withTimeout, type QueryFn } from '../../../../lib/server/db'
import { reportError } from '../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const QUERY_TIMEOUT_MS = 8_000

async function connect(): Promise<QueryFn | undefined> {
  if (!databaseConfigured()) return undefined
  await getAnalyticsRepo()
  const pool = getPool()
  return async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), QUERY_TIMEOUT_MS)
    return { rows: result.rows as Record<string, unknown>[] }
  }
}

/**
 * Values past transactions on other chains by reading them back from their chain, a batch per
 * call. Admin only. GET says how many are left; POST does one batch and says how many remain.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  const query = await connect().catch(() => undefined)
  if (query === undefined) return NextResponse.json({ error: 'no_database' }, { status: 503 })
  try {
    return NextResponse.json({ remaining: await remainingToValue(query) })
  } catch (e) {
    reportError('admin/backfill', e)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  const query = await connect().catch(() => undefined)
  if (query === undefined) return NextResponse.json({ error: 'no_database' }, { status: 503 })
  try {
    return NextResponse.json(await backfillBatch(query))
  } catch (e) {
    reportError('admin/backfill', e)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
