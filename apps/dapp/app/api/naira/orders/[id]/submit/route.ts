import { stellarNetwork } from '@intent/config'
import { NextResponse } from 'next/server'

import { assertNairaPayment } from '../../../../../../lib/naira/build-payment'
import { guardNaira } from '../../../../../../lib/naira/guard'
import { getNairaOrderRepo } from '../../../../../../lib/naira/orders'
import { logExecution } from '../../../../../../lib/server/analytics'
import { enforceRateLimit } from '../../../../../../lib/server/rate-limit'
import { sponsorForRequest } from '../../../../../../lib/sponsor/sponsor-request'
import { submitSignedSwap } from '../../../../../../lib/swap/submit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Submits the signed payment for an order.
 *
 * The stored order is read again and the envelope re-asserted against it. The
 * bytes passed through a browser and a wallet extension since they were built,
 * so a payment that matched at build and not now is refused.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } }
): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

  const parsed = (await request.json().catch(() => null)) as { signedXdr?: unknown } | null
  if (parsed === null || typeof parsed.signedXdr !== 'string' || parsed.signedXdr === '') {
    return NextResponse.json({ error: 'signedXdr is required' }, { status: 400 })
  }
  const signedXdr = parsed.signedXdr

  const repo = await getNairaOrderRepo()
  const row = await repo.getForEmail(context.params.id, guard.email)
  if (row === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (row.status !== 'waiting' || row.paymentHash !== undefined) {
    return NextResponse.json(
      { error: 'not_payable', message: 'This payout has already been paid or has ended.' },
      { status: 409 }
    )
  }

  try {
    assertNairaPayment(signedXdr, row.account, {
      destination: row.depositAddress,
      amountXlm: row.amountXlm,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'refusing to submit' },
      { status: 400 }
    )
  }

  const sent = await sponsorForRequest(request, signedXdr, row.account)
  const result = await submitSignedSwap(sent.xdr)
  await logExecution({
    kind: 'offramp',
    account: row.account,
    feeSponsored: sent.sponsored,
    result,
    signedXdr: sent.xdr,
  })
  if (!result.ok) return NextResponse.json(result)

  await repo.setPaymentHash(row.id, result.hash)
  return NextResponse.json({
    ...result,
    feeSponsored: sent.sponsored,
    explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${result.hash}`,
  })
}
