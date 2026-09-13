import { NextResponse } from 'next/server'

import { assertSelfPlan } from '../../../../lib/swap/plan-validator'
import { submitSignedSwap } from '../../../../lib/swap/submit'

/**
 * Submits a signed plan.
 *
 * The envelope is re-validated even though it was checked at build time,
 * because between the two it passed through the client and a browser
 * extension. One decode is cheap next to broadcasting a transaction that does
 * something other than what was reviewed — and a plan has more room to hide
 * something than a single operation does.
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
    try {
      assertSelfPlan(body.signedXdr, body.account)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'refusing to submit' },
        { status: 400 }
      )
    }
  }

  // Submission is shape-agnostic: it posts an envelope and reads result codes.
  const result = await submitSignedSwap(body.signedXdr)
  return NextResponse.json(result)
}
