import { NextResponse } from 'next/server'

import { readPerpFacts } from '../../../../lib/perps/market-facts'
import { createNoetherClient } from '../../../../lib/perps/noether-client'

/**
 * Noether's live markets, for the browser.
 *
 * The parser needs the market list to recognise "long XLM" at all, and the
 * card needs the mark price. Both come from the gateway through the server,
 * so the gateway's address stays a server-side setting and the browser
 * never learns whether the venue is a dev-tagged container app.
 *
 * `online: false` is an ordinary answer, not an error: the venue could not
 * be read or has paused its market, and the parser then declines every perp.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const facts = await readPerpFacts(createNoetherClient()).catch(() => undefined)
  if (facts === undefined) {
    return NextResponse.json({ online: false, markets: [] })
  }
  return NextResponse.json({ online: true, ...facts })
}
