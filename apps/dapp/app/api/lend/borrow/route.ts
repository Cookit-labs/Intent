import { NextResponse } from 'next/server'

import { buildBlendBorrow, prepareBlendWithdraw } from '../../../../lib/lend/blend-client'
import { explainPoolError, isTransientPoolError } from '../../../../lib/lend/pool-errors'
import { readReserveList } from '../../../../lib/lend/reserves'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { reportError } from '../../../../lib/server/report'

/**
 * Builds a borrow against collateral already posted.
 *
 * The simulation is doing more work here than on any other lend route. A
 * supply can fail on a cap; a withdrawal on liquidity. A borrow is refused for
 * two entirely different reasons that look identical from the outside:
 *
 *   #1205 — the position cannot support it. More collateral, or borrow less.
 *   #1207 — the *reserve* is too heavily borrowed right now. Nothing to do
 *           with this account, and it may clear on its own.
 *
 * Telling those apart is most of what a user needs, which is why the response
 * carries `transient` alongside the message rather than leaving the client to
 * parse prose.
 *
 * **The health check lives in the contract, not here.** This route never
 * decides a borrow is safe — it asks the pool, and reports the refusal. An
 * app-side check would be a second opinion that could drift from the one that
 * actually governs liquidation.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BorrowBody {
  account?: string
  asset?: string
  /** Base units. Required: there is no "borrow everything". */
  amount?: string
}

// No mainnet trade cap here. This venue is testnet-only (`networks` in
// lib/venues.ts) and its builder refuses any other network, so nothing is
// spent on mainnet through this route. Give it `assertTradeWithinCap` before
// the venue gains `networks: ['mainnet']`.
export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: BorrowBody
  try {
    body = (await request.json()) as BorrowBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (typeof body.asset !== 'string' || body.asset === '') {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  // Unlike a withdrawal or a repayment, an absent amount is a client bug
  // rather than a request to act on everything: the borrowable maximum depends
  // on prices and spare liquidity, so there is nothing for the pool to clamp
  // to.
  if (typeof body.amount !== 'string' || body.amount === '') {
    return NextResponse.json({ error: 'amount_required' }, { status: 400 })
  }

  try {
    const accepted = await readReserveList()
    if (!accepted.includes(body.asset)) {
      return NextResponse.json({ error: 'Blend does not lend this asset.' }, { status: 400 })
    }
  } catch (e) {
    reportError('lend/borrow', e, { account: body.account, asset: body.asset })
    return NextResponse.json({ error: 'Could not read Blend reserves.' }, { status: 502 })
  }

  try {
    const built = await buildBlendBorrow({
      account: body.account,
      asset: body.asset,
      amount: body.amount,
    })

    const prepared = await prepareBlendWithdraw(built.xdr)
    if (!prepared.ok) {
      return NextResponse.json(
        {
          error: explainPoolError(prepared.reason),
          // Whether waiting could help. "The pool is full" and "you need more
          // collateral" demand opposite responses, and both arrive here as a
          // four-digit number.
          transient: isTransientPoolError(prepared.reason),
        },
        { status: 400 }
      )
    }

    return NextResponse.json({
      xdr: prepared.xdr,
      asset: built.asset,
      amount: built.amount,
      recipient: built.recipient,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the borrow' },
      { status: 400 }
    )
  }
}
