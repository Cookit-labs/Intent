import { NextResponse } from 'next/server'

export function connectFirst(): NextResponse {
  return NextResponse.json(
    { error: 'unauthenticated', message: 'Connect your wallet so the team can reply to you.' },
    { status: 401 }
  )
}

export function noDatabase(): NextResponse {
  return NextResponse.json(
    { error: 'no_database', message: 'Help tickets are not available right now.' },
    { status: 503 }
  )
}

export function unreadable(): NextResponse {
  return NextResponse.json(
    { error: 'invalid_body', message: 'That message could not be read. Try again.' },
    { status: 400 }
  )
}

export function notFound(): NextResponse {
  return NextResponse.json(
    { error: 'not_found', message: 'That ticket was not found.' },
    { status: 404 }
  )
}
