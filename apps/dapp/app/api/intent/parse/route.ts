import { NextResponse } from 'next/server'

import {
  LENDABLE_ONLY,
  OFFRAMP_ANCHORS,
  lendingVenuesOn,
  unknownTickers,
} from '../../../../lib/intent-read-policy'
import { isLlmParseConfigured, readIntentWithLlm } from '../../../../lib/parse-intent-llm'
import { tradeableSymbols, resolveVerifiedAsset } from '../../../../lib/swap/asset-registry'
import { ensureLiveAssets, tickersIn } from '../../../../lib/swap/live-assets'
import { logIntentRead } from '../../../../lib/server/analytics'
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

  // A token named in the sentence that the app does not hold by hand is looked
  // up and, only if its issuer proves itself, admitted for this request.
  await ensureLiveAssets(tickersIn(body.text))

  const read = await readIntentWithLlm(body.text, {
    // The model may only name assets this app can actually trade. Checked here
    // rather than trusted, because a hallucinated ticker reaching the quoter as
    // a real instruction is a trap this codebase has hit once already.
    allowedSymbols: [...tradeableSymbols(), ...(LENDABLE_ONLY[chain] ?? [])],
    allowedVenues: lendingVenuesOn(chain),
    allowedAnchors: OFFRAMP_ANCHORS[chain] ?? [],
  })

  if (read === null) {
    // A ticker typed in capitals that nothing here recognises is most likely
    // the reason. Saying so lets the chat ask which token was meant, instead of
    // the sentence silently going to a parser that cannot read it either.
    const unknown = unknownTickers(body.text)
    if (unknown.length > 0) {
      await logIntentRead({ understood: false, reason: 'unknown_token' })
      return NextResponse.json({ understood: false, reason: 'unknown_token', tokens: unknown })
    }
    await logIntentRead({ understood: false, reason: 'unreadable' })
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
    await logIntentRead({ understood: false, reason: 'not_tradeable' })
    return NextResponse.json({ understood: false, reason: 'not_tradeable' })
  }

  await logIntentRead({
    understood: true,
    action: read.action,
    tokenIn: read.tokenIn,
    tokenOut: read.tokenOut,
    sizeUsd: read.amountUsd,
  })

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
    // Tokens admitted live, so the page can trade them without a second lookup.
    // Absent for the hand-written ones, which the page already knows.
    liveAssets: [read.tokenIn, read.tokenOut].flatMap((symbol) => {
      const asset = resolveVerifiedAsset(symbol)
      return asset !== undefined && asset.category === 'token' ? [asset] : []
    }),
  })
}
