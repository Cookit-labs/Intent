import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  LENDABLE_ONLY,
  OFFRAMP_ANCHORS,
  lendingVenuesOn,
  unknownTickers,
} from '../../../../lib/intent-read-policy'
import { orchestrateWithLlm } from '../../../../lib/orchestrate/orchestrate'
import { isLlmParseConfigured } from '../../../../lib/parse-intent-llm'
import { logIntentRead } from '../../../../lib/server/analytics'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { resolveVerifiedAsset, tradeableSymbols } from '../../../../lib/swap/asset-registry'
import { ensureLiveAssets, tickersIn } from '../../../../lib/swap/live-assets'

/**
 * Decides what a typed message is, and reads it when it is an instruction.
 *
 * Server-side because the model key is, and must stay, server-side.
 *
 * **Every answer here is a 200.** `outcome: 'unavailable'` means the message
 * could not be read, which the chat reports; it is an ordinary result, not an
 * error. There is no keyword fallback behind it, on purpose: a reading that
 * cannot tell an instruction from "I want to go jogging" would run the second as
 * a trade.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(500),
      })
    )
    .min(1)
    .max(12),
  /** What earlier turns of the chat established, one line each. */
  context: z.array(z.string().max(300)).max(6).optional(),
  chain: z.string().max(32).optional(),
})

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'compete')
  if (limited !== undefined) return limited

  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const { turns, context } = parsed.data
  const chain = parsed.data.chain ?? 'stellar'

  if (!isLlmParseConfigured()) {
    return NextResponse.json({ outcome: 'unavailable', reason: 'not_configured' })
  }

  // The latest thing the user typed is what names a token for the first time.
  const latest = [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''

  // A token named in the sentence that the app does not hold by hand is looked
  // up and, only if its issuer proves itself, admitted for this request.
  await ensureLiveAssets(tickersIn(latest))

  const result = await orchestrateWithLlm(turns, {
    ...(context !== undefined ? { context } : {}),
    // The model may only name assets this app can actually trade. Checked here
    // rather than trusted, because a hallucinated ticker reaching the quoter as
    // a real instruction is a trap this codebase has hit once already.
    allowedSymbols: [...tradeableSymbols(), ...(LENDABLE_ONLY[chain] ?? [])],
    allowedVenues: lendingVenuesOn(chain),
    allowedAnchors: OFFRAMP_ANCHORS[chain] ?? [],
  })

  if (result === null) {
    // A ticker typed in capitals that nothing here recognises is most likely
    // the reason. Saying so lets the chat ask which token was meant.
    const unknown = unknownTickers(latest)
    if (unknown.length > 0) {
      await logIntentRead({ understood: false, reason: 'unknown_token' })
      return NextResponse.json({ outcome: 'unavailable', reason: 'unknown_token', tokens: unknown })
    }
    await logIntentRead({ understood: false, reason: 'unreadable' })
    return NextResponse.json({ outcome: 'unavailable', reason: 'unreadable' })
  }

  switch (result.status) {
    case 'ask':
      return NextResponse.json({ outcome: 'ask', question: result.question })

    case 'help':
      await logIntentRead({ understood: false, reason: 'help' })
      return NextResponse.json({ outcome: 'help' })

    case 'out_of_scope':
      await logIntentRead({ understood: false, reason: 'out_of_scope' })
      return NextResponse.json({ outcome: 'out_of_scope', reason: result.reason })

    case 'unclear':
      await logIntentRead({ understood: false, reason: 'unclear' })
      return NextResponse.json({ outcome: 'unclear' })

    case 'act': {
      const { reading } = result

      // Widening the allowlist let the model *name* wBTC; it must not let a
      // borrow-only asset through as a trade. Nothing in this app can route one.
      const lendableOnly = LENDABLE_ONLY[chain] ?? []
      if (
        reading.action === 'swap' &&
        (lendableOnly.includes(reading.tokenIn) || lendableOnly.includes(reading.tokenOut))
      ) {
        await logIntentRead({ understood: false, reason: 'not_tradeable' })
        return NextResponse.json({ outcome: 'unavailable', reason: 'not_tradeable' })
      }

      await logIntentRead({
        understood: true,
        action: reading.action,
        tokenIn: reading.tokenIn,
        tokenOut: reading.tokenOut,
        sizeUsd: reading.amountUsd,
      })

      return NextResponse.json({
        outcome: 'act',
        action: reading.action,
        amountIsUsd: reading.amountIsUsd,
        tokenIn: reading.tokenIn,
        tokenOut: reading.tokenOut,
        amountUsd: reading.amountUsd,
        amountStated: reading.amountStated,
        // Null rather than omitted, so the client distinguishes "no follow-on"
        // from a field that failed to serialise.
        followOn: reading.followOn,
        style: result.style,
        ...(result.limitPriceUsd !== undefined ? { limitPriceUsd: result.limitPriceUsd } : {}),
        instruction: result.instruction,
        context: result.context,
        // Tokens admitted live, so the page can trade them without a second lookup.
        liveAssets: [reading.tokenIn, reading.tokenOut].flatMap((symbol) => {
          const asset = resolveVerifiedAsset(symbol)
          return asset !== undefined && asset.category === 'token' ? [asset] : []
        }),
      })
    }
  }
}
