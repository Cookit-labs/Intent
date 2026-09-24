import { NextResponse } from 'next/server'

import { configuredLendingVenues } from '../../../../lib/lend/venues'
import { isLlmParseConfigured, readIntentWithLlm } from '../../../../lib/parse-intent-llm'
import { tradeableSymbols } from '../../../../lib/swap/asset-registry'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Reads a typed instruction into a structured intent.
 *
 * Server-side because the model key is, and must stay, server-side. The browser
 * sends the sentence and receives a reading of it; it never holds a credential.
 *
 * **This route is allowed to answer "I could not read it".** A 200 with
 * `understood: false` is an ordinary outcome, not an error, and the client
 * falls back to its regex parser. That ordering is the whole safety argument
 * for putting a model in front of parsing: an outage, a missing key or a slow
 * response must leave the app exactly as capable as it was before, never less.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Lending venues that exist per chain. Empty means the chain has none.
 *
 * Read per request rather than once: on Stellar the list is whatever this
 * deployment is configured for, and DeFindex is in it only while its key is.
 */
function lendingVenuesOn(chain: string): string[] {
  return chain === 'stellar' ? configuredLendingVenues() : []
}

/** Anchors that withdraw to fiat, per chain. */
const OFFRAMP_ANCHORS: Record<string, string[]> = {
  stellar: ['testanchor', 'moneygram'],
  arc: [],
}

/**
 * Assets that can be borrowed but not traded here.
 *
 * The two vocabularies genuinely differ. `tradeableSymbols()` answers "what can
 * this app swap" — XLM, USDC and CETES — while Blend's pool lends four
 * reserves including wBTC and wETH, which have no route in this app's registry.
 *
 * Without these the model reads "borrow wBTC" perfectly and the reading is then
 * thrown away for naming an unknown ticker, which looks exactly like a parse
 * failure. Confirmed by reading each reserve contract's own `symbol` rather
 * than assuming, since Blend's USDC is a different issuer from Circle's.
 */
const LENDABLE_ONLY: Record<string, string[]> = {
  stellar: ['WBTC', 'WETH'],
  arc: [],
}

interface ParseBody {
  text?: string
  chain?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'compete')
  if (limited !== undefined) return limited

  let body: ParseBody
  try {
    body = (await request.json()) as ParseBody
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return NextResponse.json({ error: 'text_required' }, { status: 400 })
  }

  // Answered rather than errored. The client's fallback is the correct
  // behaviour here, and a 500 would make a normal configuration look broken.
  if (!isLlmParseConfigured()) {
    return NextResponse.json({ understood: false, reason: 'not_configured' })
  }

  const chain = typeof body.chain === 'string' ? body.chain : 'stellar'

  const read = await readIntentWithLlm(body.text, {
    // The model may only name assets this app can actually trade. Checked here
    // rather than trusted, because a hallucinated ticker reaching the quoter as
    // a real instruction is a trap this codebase has hit once already.
    allowedSymbols: [...tradeableSymbols(), ...(LENDABLE_ONLY[chain] ?? [])],
    allowedVenues: lendingVenuesOn(chain),
    allowedAnchors: OFFRAMP_ANCHORS[chain] ?? [],
  })

  if (read === null) {
    return NextResponse.json({ understood: false, reason: 'unreadable' })
  }

  // Widening the allowlist above let the model *name* wBTC; it must not let a
  // borrow-only asset through as a trade. Nothing in this app can route one, so
  // a swap naming one would reach the quoter as a real instruction — the
  // ticker-impersonation trap this codebase has hit once already.
  const lendableOnly = LENDABLE_ONLY[chain] ?? []
  const isTrade = read.action === 'swap'
  const namesLendableOnly =
    lendableOnly.includes(read.tokenIn) || lendableOnly.includes(read.tokenOut)

  if (isTrade && namesLendableOnly) {
    return NextResponse.json({ understood: false, reason: 'not_tradeable' })
  }

  return NextResponse.json({
    understood: true,
    // What the user wants done. 'supply' means an asset already held goes into
    // a lending pool with no trade — the reading the schema could not express
    // before, so "supply my XLM to Blend" was reported as a swap and executed
    // as one.
    action: read.action,
    amountIsUsd: read.amountIsUsd,
    tokenIn: read.tokenIn,
    tokenOut: read.tokenOut,
    amountUsd: read.amountUsd,
    amountStated: read.amountStated,
    // Null rather than omitted, so the client distinguishes "no follow-on" from
    // a field that failed to serialise.
    followOn: read.followOn,
  })
}
