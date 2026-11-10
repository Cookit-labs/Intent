import { NextResponse } from 'next/server'

import { chainModule } from '../../../../../lib/chains/registry'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { liveYields } from '../../../../../lib/server/live-yields'
import { reportError } from '../../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SYMBOL = /^[A-Z0-9.]{1,12}$/

/** What each venue on this chain pays to supply an asset, read now and never kept. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const { chain } = await params
  if (chain !== 'stellar' && chainModule(chain) === undefined) {
    return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })
  }
  const url = new URL(request.url)
  const asset = (url.searchParams.get('asset') ?? '').trim().toUpperCase()
  if (!SYMBOL.test(asset)) return NextResponse.json({ error: 'invalid_asset' }, { status: 400 })
  const account = url.searchParams.get('account') ?? undefined

  try {
    const rates = await liveYields(chain, asset, account)
    return NextResponse.json({ rates }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    reportError('chain/yields', e, { chain, asset })
    return NextResponse.json({ error: 'yields_unavailable' }, { status: 503 })
  }
}
