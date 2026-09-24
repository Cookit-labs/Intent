import { NextResponse } from 'next/server'

import { assertSelfOffer } from '../../../../lib/swap/build-offer'
import { submitSignedSwap } from '../../../../lib/swap/submit'
import { sponsorForSubmission } from '../../../../lib/sponsor/sponsor'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Submits a signed offer to the network.
 *
 * Separate from `/api/swap/submit` for the same reason the builders are
 * separate: that route asserts the envelope is a self-directed path payment,
 * which every offer fails. Widening it to accept both would mean one check
 * that admits two shapes, and the swap guarantee is worth more than the
 * duplicated file.
 *
 * The signed bytes are re-checked here even though they were checked at build
 * time, because between the two they passed through the client and a browser
 * extension. One decode is cheap next to broadcasting something unintended.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

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
    try {
      assertSelfOffer(body.signedXdr, body.account)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'refusing to submit' },
        { status: 400 }
      )
    }
  }

  // Submission is asset-agnostic: it posts an envelope and reads back result
  // codes, so the swap submitter serves offers unchanged.
  // The app pays the fee when a sponsor key is configured. The user's own
  // signed bytes are wrapped, never altered, and a bump that cannot be made
  // sends the original instead, paying its own fee as before.
  const sent = await sponsorForSubmission(body.signedXdr, String(body.account ?? ''))
  const result = await submitSignedSwap(sent.xdr)
  return NextResponse.json({ ...result, feeSponsored: sent.sponsored })
}
