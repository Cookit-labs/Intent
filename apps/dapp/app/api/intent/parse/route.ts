import { NextResponse } from 'next/server'

import { isLlmParseConfigured, readIntentWithLlm } from '../../../../lib/parse-intent-llm'
import { tradeableSymbols } from '../../../../lib/swap/asset-registry'

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

/** Lending venues that exist per chain. Empty means the chain has none. */
const LENDING_VENUES: Record<string, string[]> = {
  stellar: ['blend'],
  arc: [],
}

interface ParseBody {
  text?: string
  chain?: string
}

export async function POST(request: Request): Promise<NextResponse> {
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
    allowedSymbols: tradeableSymbols(),
    allowedVenues: LENDING_VENUES[chain] ?? [],
  })

  if (read === null) {
    return NextResponse.json({ understood: false, reason: 'unreadable' })
  }

  return NextResponse.json({
    understood: true,
    tokenIn: read.tokenIn,
    tokenOut: read.tokenOut,
    amountUsd: read.amountUsd,
    amountStated: read.amountStated,
    // Null rather than omitted, so the client distinguishes "no follow-on" from
    // a field that failed to serialise.
    followOn: read.followOn,
  })
}
