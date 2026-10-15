import { NextResponse } from 'next/server'
import { z } from 'zod'

import { clarifyWithLlm } from '../../../../lib/clarify/clarify'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

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
})

/**
 * Asks the user one question before agents are spent on a request that is
 * missing something, or returns the request written out on its own.
 *
 * `skip` is an ordinary answer: no key, a slow model or a reply that could not
 * be used all mean "carry on with what was typed", never an error, so a model
 * outage leaves the chat as capable as before this existed.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await enforceRateLimit(request, 'compete')
  if (limited !== undefined) return limited

  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const result = await clarifyWithLlm(parsed.data.turns, {
    ...(parsed.data.context !== undefined ? { context: parsed.data.context } : {}),
  })
  if (result === null) return NextResponse.json({ status: 'skip' })
  return NextResponse.json(result)
}
