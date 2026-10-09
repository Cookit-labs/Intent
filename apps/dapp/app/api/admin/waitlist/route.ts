import { NextResponse } from 'next/server'

import { isAdminRequest } from '../../../../lib/server/admin-session'
import { addSignup, listSignups, normalizeEmail, setStatus } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Waitlist administration.
 *
 * Open to the admin only: a signed session cookie, or the shared token in a header
 * for scripts. There is no user system to hang a role on; the gate authenticates
 * testers, not staff.
 */

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  return NextResponse.json({ signups: await listSignups() })
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'auth')
  if (limited !== undefined) return limited

  if (!isAdminRequest(request)) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  try {
    const body = (await request.json()) as { email?: unknown; status?: unknown }
    if (typeof body.email !== 'string') {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
    }
    if (body.status !== 'pending' && body.status !== 'accepted' && body.status !== 'rejected') {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    }

    const email = normalizeEmail(body.email)
    // Accepting an address that never signed up must still let it in, so the row
    // is made first: `setStatus` only updates rows that exist.
    if (body.status === 'accepted') await addSignup(email, null)
    await setStatus(email, body.status)
    return NextResponse.json({ status: 'updated' })
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
}
