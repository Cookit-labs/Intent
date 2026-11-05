import { isChainSlug } from '@intent/config'
import { NextResponse } from 'next/server'

import { fetchNativeCoinPrice } from '../../../../lib/prices/native-coin'

/** The price of a chain's own coin. A null price is an ordinary answer: nothing fresh to show. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const chain = new URL(request.url).searchParams.get('chain') ?? ''
  if (!isChainSlug(chain)) return NextResponse.json({ error: 'unknown chain' }, { status: 400 })
  return NextResponse.json({ price: (await fetchNativeCoinPrice(chain)) ?? null })
}
