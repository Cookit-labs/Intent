import { NextResponse } from 'next/server'

import { chainModule } from '../../../../../lib/chains/registry'
import { BALANCE_DEADLINE_MS, ChainActionRefused } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20

/** Every token the account holds on this chain, read when asked and never kept. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const account = new URL(request.url).searchParams.get('account') ?? ''
  try {
    const balances = await chainApi.balances(account, AbortSignal.timeout(BALANCE_DEADLINE_MS))
    return NextResponse.json(balances, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
    }
    reportError('chain/balances', e, { chain: chainApi.chain })
    return NextResponse.json({ error: 'balances_unavailable' }, { status: 503 })
  }
}
