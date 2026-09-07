import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { SESSION_COOKIE, readSession } from '../../../../lib/server/session'

/** Lets the client render the gate without duplicating cookie parsing. */
export async function GET(): Promise<NextResponse> {
  const token = cookies().get(SESSION_COOKIE)?.value
  const session = readSession(token)
  return NextResponse.json(
    session === undefined
      ? { authenticated: false }
      : { authenticated: true, email: session.email }
  )
}
