import { NextResponse } from 'next/server'

import { sponsorAccount, sponsorConfigured } from '../../../lib/sponsor/sponsor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Whether this deployment pays network fees for its users, and from which
 * account. Public by design: the account is on the ledger anyway, and a
 * client that knows fees are covered can stop warning about them.
 */
export async function GET(): Promise<Response> {
  const account = sponsorAccount()
  return NextResponse.json({
    sponsored: sponsorConfigured() && account !== undefined,
    ...(account !== undefined ? { account } : {}),
  })
}
