import { NextResponse } from 'next/server'

import { chainModule } from '../../../../../lib/chains/registry'
import { tokenBySymbol } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A listed token's dollar price, from the same source the race uses, to size "$5 of SOL". */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'read')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const token = tokenBySymbol(chainApi.tokens, new URL(request.url).searchParams.get('token') ?? '')
  if (token === undefined) return NextResponse.json({ error: 'unknown_token' }, { status: 404 })

  try {
    const priceUsd = await chainApi.priceUsd(token)
    if (priceUsd === undefined) {
      return NextResponse.json({ error: 'price_unavailable' }, { status: 503 })
    }
    return NextResponse.json(
      { priceUsd, decimals: token.decimals },
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (e) {
    reportError('chain/price', e, { chain: chainApi.chain })
    return NextResponse.json({ error: 'price_unavailable' }, { status: 503 })
  }
}
