import { NextResponse } from 'next/server'

import { ChainActionRefused } from '../../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../../lib/server/report'
import { createLinqClient } from '../../../../../../lib/linq/client'
import { createWeaveClient } from '../../../../../../lib/weave/client'
import { depositChain } from '../../../../../../lib/weave/deposit'
import { chainRefusal, guardCashout } from '../../../../../../lib/weave/guard'
import {
  depositExpectation,
  getWeaveOrderRepo,
  payRefusal,
  safeForReport,
  SEND_STARTED,
  syncOrder,
} from '../../../../../../lib/weave/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Builds the deposit for a stored order, ready for signature.
 *
 * The browser names an order; it does not name a destination or an amount. Both are
 * read from the stored row, and what the chain's builder produced is read back against
 * them before anyone is asked to sign it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const repo = await getWeaveOrderRepo()
  const row = await repo.getForEmail((await context.params).id, guard.email)
  if (row === undefined) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const onThisNetwork = chainRefusal(row.chain)
  if (onThisNetwork !== undefined) return onThisNetwork
  if (row.sendStarted) {
    return NextResponse.json({ error: 'send_started', message: SEND_STARTED }, { status: 409 })
  }

  const refused = payRefusal(await syncOrder(repo, row, createWeaveClient(), createLinqClient()))
  if (refused !== undefined) {
    return NextResponse.json(
      { error: refused.code, message: `${refused.reason} Nothing was signed or sent.` },
      { status: refused.status }
    )
  }

  const deposit = depositChain(row.chain)
  const expectation = depositExpectation(row)
  try {
    await deposit.assertCanPay?.(expectation)
    const signing = await deposit.build(expectation)
    deposit.assertSafe(signing, expectation)
    return NextResponse.json({ signing })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      return NextResponse.json({ error: 'refused', message: e.message }, { status: 422 })
    }
    reportError('cashout/build', safeForReport(e, row), { chain: row.chain, orderId: row.id })
    return NextResponse.json(
      {
        error: 'build_failed',
        message:
          'The deposit could not be prepared. Nothing was signed or sent. Try again shortly.',
      },
      { status: 502 }
    )
  }
}
