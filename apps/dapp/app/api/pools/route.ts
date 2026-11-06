import { NextResponse } from 'next/server'

import { enforceRateLimit } from '../../../lib/server/rate-limit'
import { reportError } from '../../../lib/server/report'
import { readPoolShares } from '../../../lib/swap/liquidity-pools'

/** An account's shares in Stellar's built-in liquidity pools, valued against live reserves. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(req, 'resolve')
  if (limited !== undefined) return limited

  const account = new URL(req.url).searchParams.get('account')
  if (account === null || account.trim() === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }

  try {
    return NextResponse.json({ shares: await readPoolShares(account) })
  } catch (e) {
    // Never an empty list: "you hold no shares" must not stand in for "could not find out".
    reportError('pools', e, { account })
    return NextResponse.json({ error: 'horizon_unreachable' }, { status: 502 })
  }
}
