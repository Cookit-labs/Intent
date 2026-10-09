import { NextResponse } from 'next/server'

import {
  ADMIN_COOKIE,
  adminCookieOptions,
  adminTokenMatches,
  createAdminSession,
  isAdminRequest,
} from '../../../../lib/server/admin-session'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Whether this browser already holds an admin session, so the page can skip the sign-in. */
export async function GET(request: Request): Promise<NextResponse> {
  return NextResponse.json({ authenticated: isAdminRequest(request) })
}

/** Signs the admin in: a right token becomes an http-only cookie. */
export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'auth')
  if (limited !== undefined) return limited

  let token: unknown
  try {
    token = ((await request.json()) as { token?: unknown }).token
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof token !== 'string' || !adminTokenMatches(token.trim())) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const session = createAdminSession()
  if (session === undefined) {
    return NextResponse.json(
      { error: 'AUTH_SECRET must be set to sign an admin in' },
      { status: 503 }
    )
  }

  const res = NextResponse.json({ authenticated: true })
  res.cookies.set(ADMIN_COOKIE, session, adminCookieOptions)
  return res
}

/** Signs the admin out by expiring the cookie. */
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ authenticated: false })
  res.cookies.set(ADMIN_COOKIE, '', { ...adminCookieOptions, maxAge: 0 })
  return res
}
