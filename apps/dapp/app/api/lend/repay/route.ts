import { NextResponse } from 'next/server'

import { buildBlendRepay, prepareBlendWithdraw } from '../../../../lib/lend/blend-client'
import { explainPoolError } from '../../../../lib/lend/pool-errors'
import { readReserveList } from '../../../../lib/lend/reserves'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Builds a repayment, in whole or in part.
 *
 * Ships alongside the borrow route and exists for the same reason the withdraw
 * route does: an app that can open a position but not close one leaves the
 * user dependent on somebody else's interface. For a debt that is worse than
 * for a supply, because the balance grows while they look for one.
 *
 * Omitting the amount repays everything, and that is the path worth
 * encouraging. A debt read a moment ago is already larger, so repaying an
 * exact figure leaves a remainder that keeps accruing — and keeps the position
 * liquidatable for a sum the user believed they had cleared.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RepayBody {
  account?: string
  asset?: string
  /** Base units, or omitted to clear the whole liability. */
  amount?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: RepayBody
  try {
    body = (await request.json()) as RepayBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (typeof body.asset !== 'string' || body.asset === '') {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  if (body.amount !== undefined && (typeof body.amount !== 'string' || body.amount === '')) {
    return NextResponse.json({ error: 'amount_invalid' }, { status: 400 })
  }

  try {
    const accepted = await readReserveList()
    if (!accepted.includes(body.asset)) {
      return NextResponse.json(
        { error: 'Blend has no reserve for this asset, so nothing can be owed on it.' },
        { status: 400 }
      )
    }
  } catch {
    return NextResponse.json({ error: 'Could not read Blend reserves.' }, { status: 502 })
  }

  try {
    const built = await buildBlendRepay({
      account: body.account,
      asset: body.asset,
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
    })

    const prepared = await prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) {
      return NextResponse.json({ error: explainPoolError(prepared.reason) }, { status: 400 })
    }

    return NextResponse.json({
      xdr: prepared.xdr,
      asset: built.asset,
      amount: built.amount,
      everything: built.everything,
      recipient: built.recipient,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the repayment' },
      { status: 400 }
    )
  }
}
