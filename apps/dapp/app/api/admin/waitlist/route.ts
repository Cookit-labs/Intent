import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

import { listSignups, normalizeEmail, setStatus } from '../../../../lib/server/db'

/**
 * Waitlist administration.
 *
 * Guarded by a shared token rather than a user role, because there is no user
 * system yet — the gate authenticates testers, not staff. A single secret in
 * the operator's environment is honest about that, and is one obvious thing to
 * replace when real admin accounts exist.
 */
function isAuthorised(request: Request): boolean {
  const expected = process.env['ADMIN_TOKEN']
  if (expected === undefined || expected.length < 16) return false

  const provided = request.headers.get('x-admin-token') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorised(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  return NextResponse.json({ signups: await listSignups() })
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorised(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  try {
    const body = (await request.json()) as { email?: unknown; status?: unknown }
    if (typeof body.email !== 'string') {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
    }
    if (body.status !== 'pending' && body.status !== 'accepted' && body.status !== 'rejected') {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    }

    await setStatus(normalizeEmail(body.email), body.status)
    return NextResponse.json({ status: 'updated' })
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
}
