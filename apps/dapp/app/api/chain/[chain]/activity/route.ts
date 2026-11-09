import { activeNetwork } from '@intent/config'
import { after, NextResponse } from 'next/server'

import { hasActivityRecord } from '../../../../../lib/chains/activity'
import { chainModule } from '../../../../../lib/chains/registry'
import { getAnalyticsRepo, type ExecutionChain } from '../../../../../lib/server/analytics'
import { valuePastTransactions } from '../../../../../lib/server/backfill-values'
import { databaseConfigured } from '../../../../../lib/server/db'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import { isWalletAddress } from '../../../../../lib/wallet/address'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * What a wallet did on this chain through the app, for its History page.
 *
 * A failure is a 503 and never an empty list: the page must not tell somebody with past
 * transactions that they have none, or invite them to make their first.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const { chain } = await params
  if (!hasActivityRecord(chain)) {
    return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })
  }
  const account = new URL(request.url).searchParams.get('account') ?? ''
  if (!isWalletAddress(account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }
  if (!databaseConfigured()) return NextResponse.json({ entries: [] })

  try {
    const repo = await getAnalyticsRepo()
    const rows = await repo.activityForAccount({
      // Other chains' actions are logged as mainnet, whatever Stellar network the page is on.
      network: chain === 'stellar' ? activeNetwork() : 'mainnet',
      chain: chain as ExecutionChain,
      account,
    })
    const venues = chainModule(chain)?.venues ?? []
    const entries = rows.map((row) => ({
      ...row,
      venue: venues.find((venue) => venue.id === row.venue)?.name ?? row.venue,
    }))
    // Transactions from before the log said what they did are read back from their chain, so they
    // name themselves on the next look without waiting for an admin to open the overview.
    if (chain !== 'stellar' && rows.some((row) => row.kind === 'unknown')) {
      after(() => valuePastTransactions())
    }
    return NextResponse.json({ entries }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    reportError('chain/activity', e, { chain })
    return NextResponse.json({ error: 'activity_unavailable' }, { status: 503 })
  }
}
