import { NextResponse } from 'next/server'
import { z } from 'zod'

import { assertFollowOnCanRun } from '../../../../../lib/chains/prepare'
import { chainModule } from '../../../../../lib/chains/registry'
import { ChainActionRefused } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import { isWalletAddress } from '../../../../../lib/wallet/address'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOTHING_MOVED = 'Nothing was signed or sent.'

const Body = z.object({
  account: z.string().min(1).max(128),
  step: z.object({
    kind: z.enum(['supply', 'stake', 'send']),
    tokenIn: z.string().min(1).max(16),
    venue: z.string().min(1).max(40).optional(),
    recipient: z.string().min(1).max(128).optional(),
  }),
})

/** Whether a step could run after a swap, asked before the swap is signed. Builds nothing. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const parsed = Body.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  if (!isWalletAddress(parsed.data.account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  try {
    const { kind, tokenIn, venue, recipient } = parsed.data.step
    await assertFollowOnCanRun(
      chainApi,
      {
        kind,
        tokenIn,
        ...(venue !== undefined ? { venue } : {}),
        ...(recipient !== undefined ? { recipient } : {}),
      },
      parsed.data.account
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      const said = e.message.endsWith(NOTHING_MOVED) ? e.message : `${e.message} ${NOTHING_MOVED}`
      return NextResponse.json({ error: said }, { status: 422 })
    }
    reportError('chain/follow-on', e, { chain: chainApi.chain })
    return NextResponse.json({ error: 'unreadable' }, { status: 502 })
  }
}
