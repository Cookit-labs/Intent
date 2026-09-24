import { NextResponse } from 'next/server'

import { buildBlendSupply, prepareBlendSupply } from '../../../../lib/lend/blend-client'
import { explainPoolError } from '../../../../lib/lend/pool-errors'
import { readReserveList } from '../../../../lib/lend/reserves'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Builds a supply to Blend, ready for signature.
 *
 * Server-side like every other builder, and simulated before it is returned.
 * The simulation is not an optimisation — Soroban requires it to compute the
 * resource footprint, and it doubles as the honest feasibility check: an
 * exceeded supply cap, a disabled reserve or an insufficient balance surfaces
 * here rather than as an on-chain failure the user has already paid for.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface LendBody {
  account?: string
  /** The reserve's asset, as a contract id. */
  asset?: string
  /** Base units. */
  amount?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: LendBody
  try {
    body = (await request.json()) as LendBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (typeof body.asset !== 'string' || body.asset === '') {
    return NextResponse.json({ error: 'asset_required' }, { status: 400 })
  }
  if (typeof body.amount !== 'string' || body.amount === '') {
    return NextResponse.json({ error: 'amount_required' }, { status: 400 })
  }

  // Checked against the pool rather than against a ticker table. Blend's USDC
  // is a different issuer from Circle's, so an asset that looks familiar can
  // still be one this pool has never heard of.
  try {
    const accepted = await readReserveList()
    if (!accepted.includes(body.asset)) {
      return NextResponse.json(
        { error: 'Blend does not accept this asset. Only its own reserves can be supplied.' },
        { status: 400 }
      )
    }
  } catch {
    return NextResponse.json({ error: 'Could not read Blend reserves.' }, { status: 502 })
  }

  try {
    const built = await buildBlendSupply({
      account: body.account,
      asset: body.asset,
      amount: body.amount,
    })

    // Soroban will not accept an unsimulated transaction, so this is required
    // rather than optional.
    const prepared = await prepareBlendSupply(built.xdr)
    if (!prepared.ok) {
      return NextResponse.json({ error: explainPoolError(prepared.reason) }, { status: 400 })
    }

    return NextResponse.json({
      xdr: prepared.xdr,
      asset: built.asset,
      amount: built.amount,
      recipient: built.recipient,
      // Approximate, and it cannot be made exact: interest accrues every
      // ledger, and `submit` takes no minimum-out. Anything rendering this must
      // say "about".
      ...(prepared.bTokens !== undefined ? { bTokens: prepared.bTokens } : {}),
    })
  } catch (e) {
    // Every refusal here is a safety property — a supply crediting somebody
    // else, an unfunded account — so the reason surfaces rather than being
    // flattened into something generic.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'could not build the supply' },
      { status: 400 }
    )
  }
}
