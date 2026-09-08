import { NextResponse } from 'next/server'

import { knownSymbols, resolveAsset, toBaseUnits } from '../../../../lib/swap/assets'
import { bestQuote, collectQuotes } from '../../../../lib/swap/quote'
import type { QuoteRequest } from '../../../../lib/swap/quote'
import { createHorizonQuoter } from '../../../../lib/swap/sources/horizon-quoter'

/**
 * Prices a swap across every configured liquidity source.
 *
 * Server-side so the agent loop can consume quotes without a round trip to the
 * browser, and so a future source needing a key does not have to move.
 *
 * Quoting deliberately does not touch the user's wallet or account. It answers
 * "what would this cost", nothing more — building and signing are separate
 * steps, and a quote request should never be able to move funds.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Bounds a single request. Quotes are cheap but not free. */
const QUOTE_TIMEOUT_MS = 15_000

const sources = [createHorizonQuoter()]

export async function POST(request: Request): Promise<NextResponse> {
  let body: {
    from?: unknown
    to?: unknown
    amount?: unknown
    kind?: unknown
  }

  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return NextResponse.json({ error: 'from and to are required' }, { status: 400 })
  }
  if (typeof body.amount !== 'string') {
    return NextResponse.json({ error: 'amount must be a decimal string' }, { status: 400 })
  }

  const from = resolveAsset(body.from)
  const to = resolveAsset(body.to)
  if (from === undefined || to === undefined) {
    // Naming an unknown asset is refused rather than guessed at: the caller is
    // ultimately a model reading free text.
    return NextResponse.json(
      { error: 'unknown_asset', supported: knownSymbols() },
      { status: 400 }
    )
  }
  if (from.code === to.code && from.issuer === to.issuer) {
    return NextResponse.json({ error: 'from and to are the same asset' }, { status: 400 })
  }

  let amount: string
  try {
    amount = toBaseUnits(body.amount)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid amount' },
      { status: 400 }
    )
  }
  if (BigInt(amount) <= BigInt(0)) {
    return NextResponse.json({ error: 'amount must be greater than zero' }, { status: 400 })
  }

  const kind = body.kind === 'strict_receive' ? 'strict_receive' : 'strict_send'
  const req: QuoteRequest =
    kind === 'strict_receive'
      ? { kind, from, to, receiveAmount: amount }
      : { kind, from, to, sendAmount: amount }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS)

  try {
    const { quotes, failures } = await collectQuotes(sources, req, controller.signal)
    const best = bestQuote(quotes)

    if (best === undefined) {
      return NextResponse.json(
        { error: 'no_route', failures },
        // 200: "no route for this pair right now" is an answer, not a fault.
        { status: 200 }
      )
    }

    // Every quote is returned, not just the winner, so the caller can show what
    // was compared rather than being asked to trust the choice.
    return NextResponse.json({ best, quotes, failures })
  } finally {
    clearTimeout(timer)
  }
}
