import { NextResponse } from 'next/server'
import { databaseConfigured } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { requesterOf } from '../../../../lib/server/requester'
import { askAssistant } from '../../../../lib/support/assistant'
import { ordersForPrompt, recentOrders } from '../../../../lib/support/context'
import { chatBody } from '../../../../lib/support/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_WALLET = 'The person has not connected a wallet, so none of their orders can be looked up.'

/** One reply from the help assistant. Nothing is stored until the person files a ticket. */
export async function POST(request: Request): Promise<NextResponse> {
  const who = requesterOf(request)
  const limited = await enforceRateLimit(request, 'support', who?.email)
  if (limited !== undefined) return limited

  const parsed = chatBody.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'That message could not be read. Try again.' },
      { status: 400 }
    )
  }

  const orders =
    who !== undefined && databaseConfigured()
      ? ordersForPrompt(await recentOrders(who.email).catch(() => []))
      : NO_WALLET

  const outcome = await askAssistant({
    turns: parsed.data.turns,
    orders,
    chain: parsed.data.chain,
    signal: request.signal,
  })

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: outcome.error,
        message: 'The assistant is not available right now. You can still send this to the team.',
      },
      { status: outcome.error === 'not_configured' ? 503 : 502 }
    )
  }
  return NextResponse.json({ reply: outcome.reply, next: outcome.next, draft: outcome.draft })
}
