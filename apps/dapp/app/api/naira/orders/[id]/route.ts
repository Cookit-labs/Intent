import { NextResponse } from 'next/server'

import { createLinqClient } from '../../../../../lib/linq/client'
import { guardNaira } from '../../../../../lib/naira/guard'
import { getNairaOrderRepo, toPublic } from '../../../../../lib/naira/orders'
import { isTerminal, normaliseStatus } from '../../../../../lib/naira/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One order's state. Reconciled with the provider on every read while it is
 * still moving, because a webhook can be missed, and falls back to the stored
 * row when the provider cannot be reached.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response

  const repo = await getNairaOrderRepo()
  // A wrong id and somebody else's id are the same answer.
  let row = await repo.getForEmail((await context.params).id, guard.email)
  if (row === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (!isTerminal(row.status)) {
    const live = await createLinqClient().getStatus(row.providerOrder)
    if (live.ok && live.value.status !== '') {
      const status = normaliseStatus(live.value.status)
      await repo.setStatus(
        row.providerOrder,
        status,
        live.value.status,
        // Only an order that has had its deposit has settled figures; a
        // waiting one keeps exactly what it was made for.
        status === 'waiting'
          ? undefined
          : { amountCoin: live.value.amountCoin, amountNgn: live.value.amountNGN }
      )
      row = (await repo.getForEmail(row.id, guard.email)) ?? row
    }
  }

  return NextResponse.json({ order: toPublic(row) })
}
