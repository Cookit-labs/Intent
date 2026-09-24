import { stellarTestnet } from '@intent/config'
import { NextResponse } from 'next/server'

import { assertOfframpPayment } from '../../../../lib/offramp/build-payment'
import { readExpectation } from '../../../../lib/offramp/read-expectation'
import { submitSignedSwap } from '../../../../lib/swap/submit'
import { sponsorForSubmission } from '../../../../lib/sponsor/sponsor'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Submits a signed offramp payment.
 *
 * The anchor is read **again** here, and the envelope re-asserted against
 * that fresh read. Between build and submit the XDR passed through the
 * browser and a wallet extension, and the anchor may have changed its mind —
 * expired the withdrawal, or moved it on. Two independent reads bracket the
 * signature; a payment that matched the first and not the second is refused.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  signedXdr?: unknown
  account?: unknown
  anchor?: unknown
  transactionId?: unknown
  authToken?: unknown
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  for (const key of ['signedXdr', 'account', 'anchor', 'transactionId', 'authToken'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }

  const read = await readExpectation({
    anchorId: body.anchor as string,
    transactionId: body.transactionId as string,
    authToken: body.authToken as string,
  })
  if (!read.ok) {
    return NextResponse.json(
      {
        error: `Refusing to submit: ${read.message}`,
        code: read.code,
        ...(read.status !== undefined ? { status: read.status } : {}),
      },
      { status: 409 }
    )
  }

  try {
    assertOfframpPayment(body.signedXdr as string, body.account as string, read.expectation)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  // The app pays the fee when a sponsor key is configured. The user's own
  // signed bytes are wrapped, never altered, and a bump that cannot be made
  // sends the original instead, paying its own fee as before.
  const sent = await sponsorForSubmission(body.signedXdr as string, body.account as string)
  const result = await submitSignedSwap(sent.xdr)
  if (!result.ok) return NextResponse.json(result)

  return NextResponse.json({
    ...result,
    feeSponsored: sent.sponsored,
    explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${result.hash}`,
  })
}
