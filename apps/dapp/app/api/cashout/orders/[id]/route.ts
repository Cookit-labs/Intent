import { NextResponse } from 'next/server'

import { createWeaveClient } from '../../../../../lib/weave/client'
import { guardCashout } from '../../../../../lib/weave/guard'
import { getWeaveOrderRepo, syncOrder, toPublic } from '../../../../../lib/weave/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One order's state. Reconciled with Weave on every read while it is still moving,
 * because a webhook can be missed, and falls back to the stored row when Weave cannot
 * be reached.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response

  const repo = await getWeaveOrderRepo()
  // A wrong id and somebody else's id are the same answer.
  const row = await repo.getForEmail((await context.params).id, guard.email)
  if (row === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const synced = await syncOrder(repo, row, createWeaveClient())
  return NextResponse.json({ order: toPublic(synced.row) })
}
