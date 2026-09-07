import { NextResponse } from 'next/server'

import { addSignup } from '../../../lib/server/db'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { email?: unknown; note?: unknown }
    if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email.trim())) {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
    }

    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : null
    const entry = await addSignup(body.email, note)

    // The response never reveals status: someone signing up should not learn
    // whether that address is already an accepted tester.
    return NextResponse.json({ status: 'received', email: entry.email })
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
}
