import { NextResponse } from 'next/server'

import { databaseConfigured } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { requesterOf } from '../../../../lib/server/requester'
import { recentOrders } from '../../../../lib/support/context'
import { connectFirst, noDatabase, unreadable } from '../../../../lib/support/http'
import { notifyTeam } from '../../../../lib/support/notify'
import { newTicketBody } from '../../../../lib/support/schemas'
import { getSupportRepo } from '../../../../lib/support/tickets'
import { toPersonView } from '../../../../lib/support/views'
import { WALLET_HEADER } from '../../../../lib/wallet-header'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The person's own tickets, newest activity first. */
export async function GET(request: Request): Promise<NextResponse> {
  const who = requesterOf(request)
  if (who === undefined) return connectFirst()
  if (!databaseConfigured()) return NextResponse.json({ tickets: [] })

  const limited = await enforceRateLimit(request, 'read', who.email)
  if (limited !== undefined) return limited

  const tickets = await (await getSupportRepo()).listForRequester(who.email)
  return NextResponse.json({ tickets: tickets.map(toPersonView) })
}

/**
 * Files the conversation as a ticket. The orders attached are looked up here, never taken from the
 * page, so a ticket shows what the records say.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const who = requesterOf(request)
  if (who === undefined) return connectFirst()
  if (!databaseConfigured()) return noDatabase()

  const limited = await enforceRateLimit(request, 'support', who.email)
  if (limited !== undefined) return limited

  const parsed = newTicketBody.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) {
    return unreadable()
  }
  const { turns, chain, draft } = parsed.data

  const repo = await getSupportRepo()
  const ticket = await repo.create({
    requester: who.email,
    wallet: request.headers.get(WALLET_HEADER)?.trim() || undefined,
    chain,
    kind: draft.kind,
    title: draft.title,
    summary: draft.summary,
    context: await recentOrders(who.email).catch(() => []),
    messages: turns.map((t) => ({ author: t.role, body: t.text })),
  })
  await notifyTeam(ticket, 'new')
  return NextResponse.json({ ticket: toPersonView(ticket) }, { status: 201 })
}
