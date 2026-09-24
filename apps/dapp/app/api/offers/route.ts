import { NextResponse } from 'next/server'

import { reportError } from '../../../lib/server/report'
import { fetchOpenOffers } from '../../../lib/swap/offers'

/**
 * An account's resting orders.
 *
 * Server-side so the browser talks to one origin rather than to Horizon
 * directly, matching how quoting and submission already work.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<NextResponse> {
  const account = new URL(req.url).searchParams.get('account')

  if (account === null || account.trim() === '') {
    return NextResponse.json({ error: 'account_required' }, { status: 400 })
  }

  try {
    const offers = await fetchOpenOffers(account.trim())
    return NextResponse.json({ offers })
  } catch (e) {
    // Distinct from an empty list on purpose: "we could not reach the network"
    // must not read as "you have no resting orders" to someone deciding
    // whether to place another.
    reportError('offers', e, { account: account.trim() })
    return NextResponse.json({ error: 'horizon_unreachable' }, { status: 502 })
  }
}
