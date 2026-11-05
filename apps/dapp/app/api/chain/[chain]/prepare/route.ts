import { NextResponse } from 'next/server'
import { z } from 'zod'

import { prepareChainAction } from '../../../../../lib/chains/prepare'
import { chainModule } from '../../../../../lib/chains/registry'
import { ChainActionRefused } from '../../../../../lib/chains/types'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import { isWalletAddress } from '../../../../../lib/wallet/address'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  account: z.string().min(1).max(128),
  request: z.object({
    kind: z.enum([
      'swap',
      'supply',
      'stake',
      'send',
      'withdraw',
      'unstake',
      'borrow',
      'repay',
      'stream',
      'invoice',
      'pay_invoice',
      'claim',
      'cancel',
    ]),
    amount: z
      .string()
      .regex(/^(\d+(\.\d+)?|all)$/)
      .max(40),
    tokenIn: z.string().min(1).max(16),
    tokenOut: z.string().min(1).max(16).optional(),
    venue: z.string().min(1).max(40).optional(),
    recipient: z.string().min(1).max(128).optional(),
    durationDays: z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    invoiceId: z
      .string()
      .regex(/^\d{1,78}$/)
      .optional(),
    streamId: z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/)
      .optional(),
  }),
})

/** Builds an action for the wallet to sign. Nothing moves until the user signs what comes back. */
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
    const {
      kind,
      amount,
      tokenIn,
      tokenOut,
      venue,
      recipient,
      durationDays,
      dueDate,
      invoiceId,
      streamId,
    } = parsed.data.request
    const prepared = await prepareChainAction(
      chainApi,
      {
        kind,
        amount,
        tokenIn,
        ...(tokenOut !== undefined ? { tokenOut } : {}),
        ...(venue !== undefined ? { venue } : {}),
        ...(recipient !== undefined ? { recipient } : {}),
        ...(durationDays !== undefined ? { durationDays } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(invoiceId !== undefined ? { invoiceId } : {}),
        ...(streamId !== undefined ? { streamId } : {}),
      },
      parsed.data.account
    )
    return NextResponse.json({ prepared })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    reportError('chain/prepare', e, { chain: chainApi.chain })
    return NextResponse.json(
      { error: 'This could not be built right now. Nothing was signed or sent.' },
      { status: 502 }
    )
  }
}
