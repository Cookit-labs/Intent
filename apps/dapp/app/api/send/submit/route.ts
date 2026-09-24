import { stellarTestnet } from '@intent/config'
import { NextResponse } from 'next/server'

import { resolveRecipient } from '../../../../lib/names/resolve'
import { assertSendPayment } from '../../../../lib/send/build-payment'
import { expectationFor, resolutionFailure } from '../../../../lib/send/prepare'
import { submitSignedSwap } from '../../../../lib/swap/submit'
import { sponsorForSubmission } from '../../../../lib/sponsor/sponsor'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Submits a signed payment to a recipient.
 *
 * The recipient is resolved **again** here, and the envelope re-asserted
 * against that fresh answer. Between build and submit the XDR passed through
 * the browser and a wallet extension, and the name may have moved — a
 * registry entry updated, a federation server answering differently. Two
 * independent resolutions bracket the signature; a payment that matched the
 * first and not the second is refused, and the refusal names both addresses.
 *
 * Nothing about the destination is taken from the body. The recipient as
 * typed, the asset and the amount are the user's own choices and are checked
 * against the signed bytes; where the money goes is the resolver's answer.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  signedXdr?: unknown
  account?: unknown
  recipient?: unknown
  asset?: unknown
  amount?: unknown
  memo?: unknown
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

  for (const key of ['signedXdr', 'account', 'recipient', 'asset', 'amount'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }
  if (body.memo !== undefined && typeof body.memo !== 'string') {
    return NextResponse.json({ error: 'memo must be text' }, { status: 400 })
  }
  const signedXdr = body.signedXdr as string
  const account = body.account as string

  let resolved
  try {
    resolved = await resolveRecipient(body.recipient as string)
  } catch (e) {
    const { status: _status, ...failure } = resolutionFailure(e)
    return NextResponse.json(
      { ...failure, error: `Refusing to submit: ${failure.error}` },
      { status: 409 }
    )
  }

  try {
    const expectation = expectationFor(
      resolved,
      body.asset as string,
      body.amount as string,
      body.memo as string | undefined
    )
    assertSendPayment(signedXdr, account, expectation)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  // The app pays the fee when a sponsor key is configured. The user's own
  // signed bytes are wrapped, never altered, and a bump that cannot be made
  // sends the original instead, paying its own fee as before.
  const sent = await sponsorForSubmission(signedXdr, account)
  const result = await submitSignedSwap(sent.xdr)
  if (!result.ok) return NextResponse.json(result)

  return NextResponse.json({
    ...result,
    feeSponsored: sent.sponsored,
    explorerUrl: `${stellarTestnet.blockExplorerUrl}/tx/${result.hash}`,
  })
}
