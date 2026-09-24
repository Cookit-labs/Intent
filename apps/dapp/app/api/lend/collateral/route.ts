import { NextResponse } from 'next/server'

import {
  buildBlendCollateralSupply,
  buildBlendCollateralWithdraw,
  prepareBlendWithdraw,
} from '../../../../lib/lend/blend-client'
import { explainPoolError } from '../../../../lib/lend/pool-errors'
import { readReserveList } from '../../../../lib/lend/reserves'
import { reportError } from '../../../../lib/server/report'

/**
 * Posting collateral, and taking it back.
 *
 * One route for both directions because they are the same call with opposite
 * request types, and splitting them would duplicate the reserve check and the
 * simulation for no gain.
 *
 * **Posting collateral is the moment a position becomes seizable**, which is
 * not true of any other lend operation this app builds. The route does not try
 * to convey that — a card does — but it is the reason this is a separate
 * endpoint from `/api/lend/build` rather than a flag on it: nothing should be
 * able to post collateral by passing an extra field to a supply.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CollateralBody {
  account?: string
  asset?: string
  /** Base units. Required to post; omit when reclaiming everything. */
  amount?: string
  /** 'post' adds collateral, 'reclaim' returns it to a plain supply balance. */
  direction?: 'post' | 'reclaim'
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: CollateralBody
  try {
    body = (await request.json()) as CollateralBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (typeof body.asset !== 'string' || body.asset === '') {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  if (body.direction !== 'post' && body.direction !== 'reclaim') {
    return NextResponse.json({ error: 'direction_required' }, { status: 400 })
  }
  if (body.amount !== undefined && (typeof body.amount !== 'string' || body.amount === '')) {
    return NextResponse.json({ error: 'amount_invalid' }, { status: 400 })
  }
  // There is no "post everything": the sentinel means a balance to reclaim,
  // and posting it would name an absurd figure rather than the wallet balance.
  if (body.direction === 'post' && body.amount === undefined) {
    return NextResponse.json({ error: 'amount_required' }, { status: 400 })
  }

  try {
    const accepted = await readReserveList()
    if (!accepted.includes(body.asset)) {
      return NextResponse.json({ error: 'Blend has no reserve for this asset.' }, { status: 400 })
    }
  } catch (e) {
    reportError('lend/collateral', e, { account: body.account, asset: body.asset })
    return NextResponse.json({ error: 'Could not read Blend reserves.' }, { status: 502 })
  }

  try {
    const built =
      body.direction === 'post'
        ? await buildBlendCollateralSupply({
            account: body.account,
            asset: body.asset,
            amount: body.amount as string,
          })
        : await buildBlendCollateralWithdraw({
            account: body.account,
            asset: body.asset,
            ...(body.amount !== undefined ? { amount: body.amount } : {}),
          })

    // The same simulation the withdrawal uses: it assembles the footprint
    // Soroban requires, and it surfaces the pool's refusal before a signature.
    // Reclaiming collateral that is backing a loan is refused here rather than
    // on chain, which is the check that matters most on this route.
    const prepared = await prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) {
      // Translated, because the pool speaks in numbers. An unrecognised code
      // passes through unchanged rather than becoming a friendly guess.
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
      { error: e instanceof Error ? e.message : 'could not build the collateral call' },
      { status: 400 }
    )
  }
}
