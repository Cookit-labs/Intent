import { NextResponse } from 'next/server'

import { SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/server/session'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'auth')
  if (limited !== undefined) return limited

  const response = NextResponse.json({ status: 'signed_out' })
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 })
  return response
}
