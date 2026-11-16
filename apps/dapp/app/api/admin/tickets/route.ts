import { NextResponse } from 'next/server'

import { isAdminRequest } from '../../../../lib/server/admin-session'
import { databaseConfigured } from '../../../../lib/server/db'
import { getSupportRepo, isTicketKind, isTicketStatus } from '../../../../lib/support/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Every ticket, newest activity first, filtered by status, kind and chain. Admin only. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  if (!databaseConfigured()) return NextResponse.json({ error: 'no_database' }, { status: 503 })

  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const kind = url.searchParams.get('kind')
  const chain = url.searchParams.get('chain')

  const repo = await getSupportRepo()
  const [tickets, open] = await Promise.all([
    repo.listAll({
      status: isTicketStatus(status) ? status : undefined,
      kind: isTicketKind(kind) ? kind : undefined,
      chain: chain !== null && chain !== '' && chain !== 'all' ? chain : undefined,
    }),
    repo.listAll({ status: 'open' }),
  ])
  return NextResponse.json({ tickets, openCount: open.length })
}
