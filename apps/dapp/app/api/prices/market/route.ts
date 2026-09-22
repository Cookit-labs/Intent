import { NextResponse } from 'next/server'

import { fetchMarketPrices } from '../../../../lib/swap/prices'

/**
 * What the app's assets are worth, from the best source it can reach.
 *
 * Served rather than read in the browser, because reaching Reflector means
 * the Stellar SDK, and the SDK does not belong in the client bundle for the
 * sake of a price. The hooks that size intents and the ticker's worth figure
 * fetch this; the agents, running server-side, call `fetchMarketPrices`
 * directly. One function, one answer, two ways in.
 *
 * Every price carries its `source`. The client is expected to show it: a
 * Reflector reading and a hardcoded fallback are both plausible-looking
 * numbers, and only one of them is a quote.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const prices = await fetchMarketPrices()
    return NextResponse.json({ prices })
  } catch {
    // `fetchMarketPrices` already degrades source by source and should not
    // throw; this is belt and braces so a price read can never take a page
    // down. An empty table is honest — callers treat absence as absence.
    return NextResponse.json({ prices: {} })
  }
}
