import { NextResponse } from 'next/server'

import { buildBlendWithdraw, prepareBlendWithdraw } from '../../../../lib/lend/blend-client'
import { explainPoolError } from '../../../../lib/lend/pool-errors'
import { readReserveList } from '../../../../lib/lend/reserves'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Builds a withdrawal from Blend, ready for signature.
 *
 * The mirror of the supply builder, and simulated for the same reason: Soroban
 * needs the simulation to compute a resource footprint, and it doubles as the
 * feasibility check.
 *
 * What it catches here is different, though. A supply can fail on a cap or a
 * balance; a withdrawal fails when the reserve has lent out too much of what it
 * holds. Blend refuses a withdrawal that would push utilisation past `max_util`
 * — 95% in this pool, which sits around 90% — so a perfectly real position can
 * be temporarily larger than the reserve can pay out. Surfacing the pool's own
 * revert reason says which of those happened.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface WithdrawBody {
  account?: string
  /** The reserve's asset, as a contract id. */
  asset?: string
  /**
   * Base units, or omitted to empty the position.
   *
   * Omitted is not a shorthand for "the balance I just read": interest accrues
   * every ledger, so an exact figure leaves dust. The builder sends a sentinel
   * the pool clamps to whatever is actually there.
   */
  amount?: string
}

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
  if (typeof body.asset !== 'string' || body.asset === '') {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  // Absent means "everything". An empty string is a client bug rather than an
  // intention, so it is refused instead of being read as the sentinel.
  if (body.amount !== undefined && (typeof body.amount !== 'string' || body.amount === '')) {
    return NextResponse.json({ error: 'amount_invalid' }, { status: 400 })
  }

  try {
    const accepted = await readReserveList()
    if (!accepted.includes(body.asset)) {
      return NextResponse.json(
        { error: 'Blend has no reserve for this asset, so there is nothing to withdraw.' },
        { status: 400 }
      )
    }
  } catch {
    return NextResponse.json({ error: 'Could not read Blend reserves.' }, { status: 502 })
  }

  try {
    const built = await buildBlendWithdraw({
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
      // What the position still holds afterwards — not the sum withdrawn. On a
      // full withdrawal this is zero, which is the clearest confirmation the
      // simulation can give that the position will actually be emptied.
      ...(prepared.remaining !== undefined ? { remaining: prepared.remaining } : {}),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the withdrawal' },
      { status: 400 }
    )
  }
}
