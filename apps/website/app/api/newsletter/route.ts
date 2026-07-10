import { NextResponse } from 'next/server'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  let email: unknown
  try {
    email = (await request.json())?.email
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }

  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email' }, { status: 400 })
  }

  // TODO: forward to a real ESP (Mailchimp, Resend, ConvertKit, …) here.
  // e.g. await fetch('https://us1.api.mailchimp.com/3.0/lists/<id>/members', { ... })

  return NextResponse.json({ ok: true })
}
