import { NextResponse } from 'next/server'

import { findByEmail, markFirstLogin, normalizeEmail } from '../../../../lib/server/db'
import { SESSION_COOKIE, createSession, sessionCookieOptions } from '../../../../lib/server/session'
import { verifyCode } from '../../../../lib/server/otp'

export async function POST(request: Request): Promise<NextResponse> {
  let email: string
  let code: string
  try {
    const body = (await request.json()) as { email?: unknown; code?: unknown }
    if (typeof body.email !== 'string' || typeof body.code !== 'string') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    email = normalizeEmail(body.email)
    code = body.code.trim()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Re-checked at verification, not just at send: acceptance can be revoked in
  // the ten minutes a code stays valid, and a withdrawn invite should not still
  // open the door.
  const entry = await findByEmail(email)
  if (entry === undefined || entry.status !== 'accepted') {
    return NextResponse.json({ status: 'not_accepted' }, { status: 403 })
  }

  const result = await verifyCode(email, code)
  if (!result.ok) {
    return NextResponse.json({ status: result.reason }, { status: 401 })
  }

  await markFirstLogin(email)

  const response = NextResponse.json({ status: 'verified', email })
  response.cookies.set(SESSION_COOKIE, createSession(email), sessionCookieOptions)
  return response
}
