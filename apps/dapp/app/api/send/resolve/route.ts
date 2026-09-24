import { NextResponse } from 'next/server'

import { resolveRecipient } from '../../../../lib/names/resolve'
import { resolutionFailure } from '../../../../lib/send/prepare'

/**
 * Resolves a recipient, so the review card can show where a name points
 * before anything is built.
 *
 * Server-side because the registry read needs the Stellar SDK, which does not
 * belong in the client bundle, and because this is the answer the card shows
 * — the client never resolves a name itself, and never tells the server what
 * a name resolved to.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let body: { recipient?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.recipient !== 'string' || body.recipient.trim() === '') {
    return NextResponse.json({ error: 'recipient is required' }, { status: 400 })
  }

  try {
    return NextResponse.json(await resolveRecipient(body.recipient))
  } catch (e) {
    const { status, ...failure } = resolutionFailure(e)
    return NextResponse.json(failure, { status })
  }
}
