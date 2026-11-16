import { NextResponse } from 'next/server'

import { databaseConfigured } from '../../../../../lib/server/db'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { requesterOf } from '../../../../../lib/server/requester'
import { connectFirst, noDatabase, notFound, unreadable } from '../../../../../lib/support/http'
import { notifyTeam } from '../../../../../lib/support/notify'
import { replyBody } from '../../../../../lib/support/schemas'
import { getSupportRepo } from '../../../../../lib/support/tickets'
import { toPersonView } from '../../../../../lib/support/views'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ id: string }>
}

/** One of the person's tickets with its thread. Reading it clears the unread badge. */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const who = requesterOf(request)
  if (who === undefined) return connectFirst()
  if (!databaseConfigured()) return noDatabase()

  const limited = await enforceRateLimit(request, 'read', who.email)
  if (limited !== undefined) return limited

  const { id } = await params
  const repo = await getSupportRepo()
  const ticket = await repo.getForRequester(id, who.email)
  if (ticket === undefined) return notFound()
  if (ticket.userUnread) await repo.markRead(id, who.email)
  return NextResponse.json({ ticket: toPersonView({ ...ticket, userUnread: false }) })
}

/** The person replies on their ticket, which hands it back to the team. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const who = requesterOf(request)
  if (who === undefined) return connectFirst()
  if (!databaseConfigured()) return noDatabase()

  const limited = await enforceRateLimit(request, 'support', who.email)
  if (limited !== undefined) return limited

  const parsed = replyBody.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return unreadable()

  const { id } = await params
  const repo = await getSupportRepo()
  if (!(await repo.addUserMessage(id, who.email, parsed.data.text))) return notFound()
  const ticket = await repo.getForRequester(id, who.email)
  if (ticket === undefined) return notFound()
  await notifyTeam(ticket, 'reply')
  return NextResponse.json({ ticket: toPersonView(ticket) })
}
