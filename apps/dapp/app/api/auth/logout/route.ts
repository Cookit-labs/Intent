import { NextResponse } from 'next/server'

import { SESSION_COOKIE, sessionCookieOptions } from '../../../../lib/server/session'

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ status: 'signed_out' })
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 })
  return response
}
