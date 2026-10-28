import { activeNetwork } from '@intent/config'
import { StrKey } from '@stellar/stellar-sdk'
import { NextResponse } from 'next/server'

import { databaseConfigured } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { getAnalyticsRepo } from '../../../../lib/server/analytics'
import { reportError } from '../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/**
 * A wallet's own agent races, each with the winning agent's reasoning and
 * the transaction this wallet actually submitted for it, when there was one.
 *
 * Why this is a question anyone can ask about any address, rather than one
 * gated behind a login: the naira cash-out history is the closer precedent
 * for app-database-backed (as opposed to on-ledger) wallet data, and it
 * does gate — but its gate exists because a cash-out carries a bank name,
 * an account number, and an email, none of which this route ever returns.
 * What this route exposes is why an agent proposed what it proposed,
 * exactly as it was shown live in the competition panel to whoever was
 * watching the race happen. A Stellar address is already public, and this
 * matches the trust model `swap/history` and the ledger itself already use
 * for everything else this wallet did.
 */
export async function GET(request: Request): Promise<Response> {
  const limited = await enforceRateLimit(request, 'resolve')
  if (limited !== undefined) return limited

  const url = new URL(request.url)
  const account = url.searchParams.get('account')
  if (account === null || !StrKey.isValidEd25519PublicKey(account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  const pageParam = Number(url.searchParams.get('page') ?? '1')
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE))

  if (!databaseConfigured()) {
    return NextResponse.json({ entries: [], hasMore: false })
  }

  try {
    const repo = await getAnalyticsRepo()
    const result = await repo.historyForAccount({
      network: activeNetwork(),
      account,
      page,
      pageSize,
    })
    return NextResponse.json(result)
  } catch (e) {
    reportError('agents/history', e)
    return NextResponse.json({ entries: [], hasMore: false })
  }
}
