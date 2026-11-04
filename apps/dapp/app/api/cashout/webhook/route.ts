import { NextResponse } from 'next/server'
import { z } from 'zod'

import { reportError } from '../../../../lib/server/report'
import { getWeaveOrderRepo } from '../../../../lib/weave/orders'
import { nextStatus } from '../../../../lib/weave/status'
import { verifyWeaveSignature } from '../../../../lib/weave/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Event = z.object({
  event: z.string().optional(),
  data: z.object({ id: z.string().min(1), status: z.string().optional() }),
})

const FROM_EVENT: Readonly<Record<string, string>> = {
  'order.completed': 'completed',
  'order.failed': 'failed',
}

/**
 * Order events from Weave.
 *
 * Verified over the bytes as they arrived, before anything is read from them,
 * because re-serialising changes what the signature covers. Weave retries on any
 * non-2xx, so an event that can never be applied gets a 200: an unknown order, a
 * replay, or one with no order id. A record that could not be written gets a 500,
 * since a retry can fix that.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = Buffer.from(await request.arrayBuffer())
  const verified = verifyWeaveSignature(
    raw,
    request.headers.get('x-weave-signature'),
    request.headers.get('x-weave-timestamp'),
    process.env['WEAVE_WEBHOOK_SECRET'] ?? ''
  )
  if (!verified) return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })

  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const parsed = Event.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true })

  const { event, data } = parsed.data
  // The status text is what the order is. The event name is only a fallback.
  const provider = data.status ?? (event === undefined ? undefined : FROM_EVENT[event])
  if (provider === undefined) return NextResponse.json({ ok: true })

  try {
    const repo = await getWeaveOrderRepo()
    const row = await repo.getByProviderOrder(data.id)
    if (row === undefined) return NextResponse.json({ ok: true })

    const status = nextStatus(row.status, provider)
    if (status !== row.status) await repo.setStatus(data.id, status, provider)
    return NextResponse.json({ ok: true })
  } catch (e) {
    reportError('cashout/webhook', e, { event })
    return NextResponse.json({ error: 'unavailable' }, { status: 500 })
  }
}
