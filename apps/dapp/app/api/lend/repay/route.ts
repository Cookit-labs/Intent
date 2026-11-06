import { NextResponse } from 'next/server'

import { buildBlendRepay, prepareBlendWithdraw } from '../../../../lib/lend/blend-client'
import { findDebt, planRepayAll, readSpendable, worthOf } from '../../../../lib/lend/exit'
import { explainExitError } from '../../../../lib/lend/pool-errors'
import { readBlendPositions, type BlendPositions } from '../../../../lib/lend/position'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { reportError } from '../../../../lib/server/report'

/**
 * Builds a repayment, in whole or in part.
 *
 * Ships alongside the borrow route and exists for the same reason the withdraw
 * route does: an app that can open a position but not close one leaves the
 * user dependent on somebody else's interface. For a debt that is worse than
 * for a supply, because the balance grows while they look for one.
 *
 * Omitting the amount repays everything the wallet can cover. The figure is
 * worked out here from the debt read now, and the pool refunds what is over: see
 * `repayAllAmount`.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RepayBody {
  account?: string
  /** The reserve's asset, as a contract id. */
  asset?: string
  /** A ticker, when a person typed one instead. */
  symbol?: string
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
  const asset = typeof body.asset === 'string' && body.asset !== '' ? body.asset : undefined
  const symbol = typeof body.symbol === 'string' && body.symbol !== '' ? body.symbol : undefined
  if (asset === undefined && symbol === undefined) {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  if (
    body.amount !== undefined &&
    (typeof body.amount !== 'string' || !/^[1-9]\d*$/.test(body.amount))
  ) {
    return NextResponse.json({ error: 'amount_invalid' }, { status: 400 })
  }

  let positions: BlendPositions
  try {
    positions = await readBlendPositions(body.account)
  } catch (e) {
    reportError('lend/repay', e, { account: body.account, asset })
    return NextResponse.json(
      { error: 'Could not read what you owe in Blend. Nothing was signed or sent.' },
      { status: 502 }
    )
  }

  const debt = findDebt(positions, {
    ...(asset !== undefined ? { assetId: asset } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
  })
  if ('refusal' in debt) {
    return NextResponse.json({ error: debt.refusal }, { status: 400 })
  }

  let amount = body.amount
  if (amount === undefined) {
    let spendable: bigint
    try {
      spendable = await readSpendable(body.account, debt.assetId)
    } catch (e) {
      reportError('lend/repay', e, { account: body.account, asset: debt.assetId })
      return NextResponse.json(
        { error: 'Could not read your wallet balance. Nothing was signed or sent.' },
        { status: 502 }
      )
    }
    const plan = planRepayAll(BigInt(debt.amount), spendable, debt.symbol)
    if ('refusal' in plan) {
      return NextResponse.json({ error: plan.refusal }, { status: 400 })
    }
    amount = plan.amount
  }

  try {
    const built = await buildBlendRepay({ account: body.account, asset: debt.assetId, amount })

    const prepared = await prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) {
      return NextResponse.json(
        { error: explainExitError(prepared.reason, 'repay') },
        { status: 400 }
      )
    }

    // Decided by what the pool says would remain, not by what was asked for: a wallet that holds
    // less than the debt, asked to "repay all", repays part of it and must be told so.
    const remaining =
      prepared.after !== undefined ? worthOf(debt, prepared.after.liabilities) : undefined

    return NextResponse.json({
      xdr: prepared.xdr,
      asset: built.asset,
      symbol: debt.symbol,
      amount: built.amount,
      owed: debt.amount,
      everything: remaining === '0',
      recipient: built.recipient,
      ...(remaining !== undefined ? { remaining } : {}),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the repayment' },
      { status: 400 }
    )
  }
}
