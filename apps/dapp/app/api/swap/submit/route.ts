import { NextResponse } from 'next/server'

import { submitSignedSwap } from '../../../../lib/swap/submit'
import { assertSelfSubmission } from '../../../../lib/swap/venue-routing'

/**
 * Submits a signed swap to the network.
 *
 * The signed envelope is re-checked before submission. It has already been
 * validated at build time, but it has since passed through the client and a
 * browser extension, and the cost of checking again is one decode against the
 * cost of broadcasting a payment to somebody else.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  let body: { signedXdr?: unknown; account?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.signedXdr !== 'string' || body.signedXdr === '') {
    return NextResponse.json({ error: 'signedXdr is required' }, { status: 400 })
  }

  if (typeof body.account === 'string' && body.account !== '') {
    // Each shape must satisfy its own assertion: a path payment proves the
    // destination is the sender, an Aquarius call proves its recipient
    // argument is. Which assertion applies is read from the bytes rather than
    // found by trial — trying the classic check and falling back to the
    // source-only Soroban one let an Aquarius envelope through with any
    // recipient at all.
    try {
      assertSelfSubmission(body.signedXdr, body.account)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'refusing to submit' },
        { status: 400 }
      )
    }
  }

  const result = await submitSignedSwap(body.signedXdr)
  return NextResponse.json(result, { status: result.ok ? 200 : 200 })
}
