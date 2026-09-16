import { NextResponse } from 'next/server'

import { fetchTestnetXlmUsd } from '../../../../lib/swap/prices'

/**
 * What XLM trades for on testnet's own order book.
 *
 * Served rather than read in the browser so the figure comes from one place and
 * can be cached per request, the same way every other market read here works.
 *
 * **A null price is an ordinary answer, not an error.** Testnet's book is thin
 * and can genuinely have no offers resting on it, in which case there is no
 * price to report — and inventing one would defeat the point of asking testnet
 * rather than mainnet.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const price = await fetchTestnetXlmUsd()
    return NextResponse.json({ price: price ?? null })
  } catch {
    // The reader already swallows its own failures; this is belt and braces so
    // a header ticker can never take the page down.
    return NextResponse.json({ price: null })
  }
}
