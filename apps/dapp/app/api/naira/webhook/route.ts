import { NextResponse } from 'next/server'

import { verifyLinqSignature } from '../../../../lib/linq/client'
import { getNairaOrderRepo } from '../../../../lib/naira/orders'
import { normaliseStatus } from '../../../../lib/naira/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface WebhookEvent {
  event?: unknown
  orderId?: unknown
  status?: unknown
  amountStableCoin?: unknown
  amountNGN?: unknown
}

/**
 * Payout events from the provider.
 *
 * Verified over the raw body before anything is read from it: `request.text()`,
 * not `request.json()`, because re-serialising changes the bytes the signature
 * covers. Acknowledged with 200 for any event whose order is unknown, since a
 * retry would not make it known.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text()
  const secret = process.env['LINQ_WEBHOOK_SECRET'] ?? ''
  if (!verifyLinqSignature(raw, request.headers.get('x-linq-signature'), secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let event: WebhookEvent
  try {
    event = JSON.parse(raw) as WebhookEvent
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (typeof event.orderId !== 'string' || event.orderId === '') {
    return NextResponse.json({ ok: true })
  }

  // The status text is what the order is, read by the same rules as every
  // other place a status comes from. The event name is only a fallback for an
  // event that carries no text: trusting it over the text moved an order the
  // provider was still watching for its deposit to "processing", and the
  // payment it was waiting for was then refused.
  const providerStatus = typeof event.status === 'string' ? event.status.trim() : ''
  const fromEvent =
    event.event === 'order.processing'
      ? 'processing'
      : event.event === 'order.completed'
        ? 'paid'
        : event.event === 'order.failed'
          ? 'failed'
          : undefined
  const status = providerStatus !== '' ? normaliseStatus(providerStatus) : fromEvent
  if (status === undefined) return NextResponse.json({ ok: true })

  // Settled figures describe what actually arrived and was paid. An order that
  // is still waiting has none, and writing the provider's rounded echo of the
  // request over it would change what the payment is asserted against.
  const settled =
    status === 'waiting'
      ? undefined
      : {
          amountCoin: typeof event.amountStableCoin === 'number' ? event.amountStableCoin : 0,
          amountNgn: typeof event.amountNGN === 'number' ? event.amountNGN : 0,
        }

  const repo = await getNairaOrderRepo()
  await repo.setStatus(event.orderId, status, providerStatus || String(event.event), settled)
  return NextResponse.json({ ok: true })
}
