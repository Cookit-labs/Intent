import { NextResponse } from 'next/server'

import { findByEmail, normalizeEmail } from '../../../../lib/server/db'
import { getEmailSender } from '../../../../lib/server/email'
import { CODE_TTL_SECONDS, checkSendRateLimit, issueCode } from '../../../../lib/server/otp'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Issues an access code — but only to an address already marked `accepted`.
 *
 * This is the actual gate. An address that is unknown or still pending gets no
 * code and no email, so being on the waitlist is not itself a way in.
 *
 * This does tell a caller whether an address is accepted, which leaks who is in
 * the private test. That is accepted deliberately: the UI has to route
 * non-accepted people to the waitlist, which is impossible behind a uniform
 * response, and membership of a testing cohort is not a secret worth a worse
 * signup flow.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let email: string
  try {
    const body = (await request.json()) as { email?: unknown }
    if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email.trim())) {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
    }
    email = normalizeEmail(body.email)
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const entry = await findByEmail(email)
  if (entry === undefined || entry.status !== 'accepted') {
    return NextResponse.json(
      { status: 'not_accepted', onWaitlist: entry !== undefined },
      { status: 200 }
    )
  }

  // Rate limiting sits after the acceptance check so that probing addresses
  // cannot consume an accepted user's send budget.
  const limit = await checkSendRateLimit(email)
  if (!limit.allowed) {
    return NextResponse.json(
      { status: 'rate_limited', retryAfter: limit.retryAfter, reason: limit.reason },
      { status: 429 }
    )
  }

  const code = await issueCode(email)
  await getEmailSender().sendOtp(email, code, CODE_TTL_SECONDS / 60)

  return NextResponse.json({ status: 'sent', expiresIn: CODE_TTL_SECONDS })
}
