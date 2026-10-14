import { NextResponse } from 'next/server'

import { buildNairaPayment } from '../../../../../../lib/naira/build-payment'
import { guardNaira } from '../../../../../../lib/naira/guard'
import { getNairaOrderRepo } from '../../../../../../lib/naira/orders'
import { enforceRateLimit } from '../../../../../../lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Builds the XLM payment for a stored order, ready for signature.
 *
 * The browser names an order; it does not name a destination or an amount.
 * Both are read from the stored row, which holds what the provider said.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } }
): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const repo = await getNairaOrderRepo()
  const row = await repo.getForEmail(context.params.id, guard.email)
  if (row === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (row.status !== 'waiting') {
    return NextResponse.json(
      { error: 'not_payable', message: 'This payout is no longer waiting for a deposit.' },
      { status: 409 }
    )
  }

  try {
    const built = await buildNairaPayment({
      account: row.account,
      expectation: { destination: row.depositAddress, amountXlm: row.amountXlm },
    })
    return NextResponse.json({
      xdr: built.xdr,
      networkPassphrase: built.networkPassphrase,
      destination: row.depositAddress,
      amountXlm: row.amountXlm,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'build_failed', message: e instanceof Error ? e.message : 'Could not build it.' },
      { status: 502 }
    )
  }
}
