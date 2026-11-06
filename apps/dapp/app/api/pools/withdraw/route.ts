import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { buildPoolExit } from '../../../../lib/swap/build-pool'

/**
 * Builds a withdrawal of every share an account holds in one pool, ready to sign.
 *
 * The operation has no recipient field: both assets can only return to the
 * account that signs it, and the network requires that account to hold a
 * trustline for each for as long as it holds the shares.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POOL_ID = /^[0-9a-f]{64}$/

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  let body: { account?: unknown; poolId?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.account !== 'string' || body.account === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }
  if (typeof body.poolId !== 'string' || !POOL_ID.test(body.poolId)) {
    return NextResponse.json({ error: 'pool_required' }, { status: 400 })
  }

  try {
    const built = await buildPoolExit({ account: body.account, poolId: body.poolId })
    return NextResponse.json({
      xdr: built.xdr,
      poolId: built.poolId,
      shares: built.shares,
      floors: built.floors,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'This withdrawal could not be built.' },
      { status: 400 }
    )
  }
}
