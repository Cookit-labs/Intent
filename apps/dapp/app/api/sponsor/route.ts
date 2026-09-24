import { NextResponse } from 'next/server'

import { sponsorAccount, sponsorBudgetToday, sponsorConfigured } from '../../../lib/sponsor/sponsor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Whether this deployment pays network fees for its users, from which
 * account, and how much of today's budget is spent. Public by design: the
 * account is on the ledger anyway, and a client that knows fees are covered
 * can stop warning about them. The budget is omitted, not errored, when the
 * ledger cannot be read.
 */
export async function GET(): Promise<Response> {
  const account = sponsorAccount()
  const budget = await sponsorBudgetToday()
  return NextResponse.json({
    sponsored: sponsorConfigured() && account !== undefined,
    ...(account !== undefined ? { account } : {}),
    ...(budget !== undefined ? { budget } : {}),
  })
}
