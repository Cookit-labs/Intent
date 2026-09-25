import { NextResponse } from 'next/server'

import { databaseConfigured } from '../../../lib/server/db'
import { sponsorAccount, sponsorBudgetToday, sponsorConfigured } from '../../../lib/sponsor/sponsor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Whether this deployment pays network fees for its users, from which
 * account, and how much of today's budget is spent. Public by design: the
 * account is on the ledger anyway, and a client that knows fees are covered
 * can stop warning about them. The budget is omitted, not errored, when the
 * ledger cannot be read. A key with no ledger configured is not a sponsor —
 * `sponsorForSubmission` refuses to pay in that state — and is reported as
 * such, with the reason, so the deploy can be fixed rather than wondered at.
 */
export async function GET(): Promise<Response> {
  const account = sponsorAccount()
  const ledger = databaseConfigured()
  const budget = ledger ? await sponsorBudgetToday() : undefined
  return NextResponse.json({
    sponsored: sponsorConfigured() && account !== undefined && ledger,
    ...(account !== undefined ? { account } : {}),
    ...(account !== undefined && !ledger ? { reason: 'no_ledger' } : {}),
    ...(budget !== undefined ? { budget } : {}),
  })
}
