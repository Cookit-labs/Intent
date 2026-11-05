import { NextResponse } from 'next/server'

import {
  buildBlendCollateralWithdraw,
  buildBlendWithdraw,
  buildBlendWithdrawEverywhere,
  prepareBlendWithdraw,
} from '../../../../lib/lend/blend-client'
import { planWithdraw, worthOf } from '../../../../lib/lend/exit'
import { explainExitError } from '../../../../lib/lend/pool-errors'
import { readBlendPositions, type BlendPositions } from '../../../../lib/lend/position'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { reportError } from '../../../../lib/server/report'

/**
 * Builds a withdrawal from Blend, ready for signature.
 *
 * Read from the position first, because a person names an asset and the pool
 * holds it in one of two forms: a plain supply and collateral are different
 * request types, and asking for the wrong one is refused as "nothing supplied"
 * over money that is really there. Both forms pay the wallet.
 *
 * The simulation is the mirror of the supply builder's, and what it catches
 * differs: a withdrawal fails when the reserve has lent out too much of what it
 * holds, or when collateral is still backing a loan. Surfacing the pool's own
 * revert reason says which of those happened.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface WithdrawBody {
  account?: string
  /** The reserve's asset, as a contract id. */
  asset?: string
  /** A ticker, when a person typed one instead. */
  symbol?: string
  /**
   * Base units, or omitted to empty the position.
   *
   * Omitted is not a shorthand for "the balance I just read": interest accrues
   * every ledger, so an exact figure leaves dust. The builder sends a sentinel
   * the pool clamps to whatever is actually there.
   */
  amount?: string
  /** Which form to take from. Omitted, the position decides. */
  from?: 'supply' | 'collateral'
}

// A withdrawal returns the account's own position to the account
// (`assertSelfPoolCall` pins `from`, `spender` and `to` to the signer), so it
// cannot move value anywhere the user did not already hold it.
export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: WithdrawBody
  try {
    body = (await request.json()) as WithdrawBody
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
  // Absent means "everything". An empty string is a client bug rather than an
  // intention, so it is refused instead of being read as the sentinel.
  if (
    body.amount !== undefined &&
    (typeof body.amount !== 'string' || !/^[1-9]\d*$/.test(body.amount))
  ) {
    return NextResponse.json({ error: 'amount_invalid' }, { status: 400 })
  }
  if (body.from !== undefined && body.from !== 'supply' && body.from !== 'collateral') {
    return NextResponse.json({ error: 'from_invalid' }, { status: 400 })
  }

  let positions: BlendPositions
  try {
    positions = await readBlendPositions(body.account)
  } catch (e) {
    reportError('lend/withdraw', e, { account: body.account, asset })
    return NextResponse.json(
      { error: 'Could not read your Blend position. Nothing was signed or sent.' },
      { status: 502 }
    )
  }

  const plan = planWithdraw(positions, {
    ...(asset !== undefined ? { assetId: asset } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(body.amount !== undefined ? { amount: body.amount } : {}),
    ...(body.from !== undefined ? { from: body.from } : {}),
  })
  if ('refusal' in plan) {
    return NextResponse.json({ error: plan.refusal }, { status: 400 })
  }

  try {
    const options = {
      account: body.account,
      asset: plan.assetId,
      ...(plan.amount !== undefined ? { amount: plan.amount } : {}),
    }
    const built =
      plan.from === 'both'
        ? await buildBlendWithdrawEverywhere(options)
        : plan.from === 'collateral'
          ? await buildBlendCollateralWithdraw(options)
          : await buildBlendWithdraw(options)

    const prepared = await prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) {
      return NextResponse.json(
        { error: explainExitError(prepared.reason, 'withdraw') },
        { status: 400 }
      )
    }

    const supplyLeft = worthOf(plan.supplied, prepared.after?.supply)
    const collateralLeft = worthOf(plan.collateral, prepared.after?.collateral)

    return NextResponse.json({
      xdr: prepared.xdr,
      asset: built.asset,
      symbol: plan.symbol,
      from: plan.from,
      amount: built.amount,
      everything: built.everything,
      recipient: built.recipient,
      // What stays behind in the form this took from: not the sum withdrawn. Zero is the
      // clearest confirmation the simulation can give that it will actually be emptied.
      ...(prepared.after !== undefined
        ? { remaining: plan.from === 'collateral' ? collateralLeft : supplyLeft }
        : {}),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the withdrawal' },
      { status: 400 }
    )
  }
}
