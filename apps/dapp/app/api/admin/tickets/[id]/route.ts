import { NextResponse } from 'next/server'

import { isAdminRequest } from '../../../../../lib/server/admin-session'
import { databaseConfigured } from '../../../../../lib/server/db'
import { recentOrders } from '../../../../../lib/support/context'
import { notFound, unreadable } from '../../../../../lib/support/http'
import { notifyPerson } from '../../../../../lib/support/notify'
import { replyBody, statusBody } from '../../../../../lib/support/schemas'
import { getSupportRepo } from '../../../../../lib/support/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ id: string }>
}

function refused(request: Request): NextResponse | undefined {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  if (!databaseConfigured()) return NextResponse.json({ error: 'no_database' }, { status: 503 })
  return undefined
}

/** A ticket, its thread, and the person's orders as they stand now beside those at filing. */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const blocked = refused(request)
  if (blocked !== undefined) return blocked

  const { id } = await params
  const ticket = await (await getSupportRepo()).get(id)
  if (ticket === undefined) return notFound()
  const current = await recentOrders(ticket.requester).catch(() => [])
  return NextResponse.json({ ticket, current })
}

/** The team replies. The person sees it in the widget, and by email when they gave one. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const blocked = refused(request)
  if (blocked !== undefined) return blocked

  const parsed = replyBody.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return unreadable()

  const { id } = await params
  const repo = await getSupportRepo()
  if (!(await repo.addAdminReply(id, parsed.data.text))) return notFound()
  const ticket = await repo.get(id)
  if (ticket === undefined) return notFound()
  await notifyPerson(ticket)
  return NextResponse.json({ ticket })
}

/** Opens, marks answered or closes a ticket. */
export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const blocked = refused(request)
  if (blocked !== undefined) return blocked

  const parsed = statusBody.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return unreadable()

  const { id } = await params
  const repo = await getSupportRepo()
  if (!(await repo.setStatus(id, parsed.data.status))) return notFound()
  return NextResponse.json({ ticket: await repo.get(id) })
}
