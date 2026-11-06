import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { logExecution } from '../../../../lib/server/analytics'
import { sponsorForRequest } from '../../../../lib/sponsor/sponsor-request'
import { assertSelfPoolWithdraw } from '../../../../lib/swap/build-pool'
import { submitSignedSwap } from '../../../../lib/swap/submit'

/**
 * Submits a signed pool withdrawal, re-checked because between build and here it
 * passed through the client and a browser extension.
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
  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account is required' }, { status: 400 })
  }

  try {
    assertSelfPoolWithdraw(body.signedXdr, body.account)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  const sent = await sponsorForRequest(request, body.signedXdr, body.account)
  const result = await submitSignedSwap(sent.xdr)
  await logExecution({
    kind: 'plan',
    account: body.account,
    feeSponsored: sent.sponsored,
    result,
    signedXdr: sent.xdr,
  })
  return NextResponse.json({ ...result, feeSponsored: sent.sponsored })
}
