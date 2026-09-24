import { NextResponse } from 'next/server'

import { resolveRecipient } from '../../../../lib/names/resolve'
import { CannotReceive, assertCanReceive, resolutionFailure } from '../../../../lib/send/prepare'
import { resolveAsset } from '../../../../lib/swap/assets'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

/**
 * Resolves a recipient, so the review card can show where a name points
 * before anything is built — and, when an asset is named, whether that
 * account can take it on testnet, so a swap-then-send is refused before the
 * swap rather than after it.
 *
 * Server-side because the registry read needs the Stellar SDK, which does not
 * belong in the client bundle, and because this is the answer the card shows
 * — the client never resolves a name itself, and never tells the server what
 * a name resolved to.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'resolve')
  if (limited !== undefined) return limited

  let body: { recipient?: unknown; asset?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  if (typeof body.recipient !== 'string' || body.recipient.trim() === '') {
    return NextResponse.json({ error: 'recipient is required' }, { status: 400 })
  }
  const asset = body.asset === undefined ? undefined : resolveAsset(String(body.asset))
  if (body.asset !== undefined && asset === undefined) {
    return NextResponse.json(
      { error: `${String(body.asset)} is not an asset this app can send` },
      { status: 400 }
    )
  }

  let resolved
  try {
    resolved = await resolveRecipient(body.recipient)
  } catch (e) {
    const { status, ...failure } = resolutionFailure(e)
    return NextResponse.json(failure, { status })
  }

  if (asset !== undefined) {
    try {
      await assertCanReceive(resolved, {
        code: asset.code,
        ...(asset.issuer !== undefined ? { issuer: asset.issuer } : {}),
      })
    } catch (e) {
      if (e instanceof CannotReceive) {
        const { status, ...failure } = resolutionFailure(e)
        return NextResponse.json(failure, { status })
      }
      return NextResponse.json(
        { error: "the recipient's account could not be checked on testnet", code: 'lookup_failed' },
        { status: 502 }
      )
    }
  }

  return NextResponse.json(resolved)
}
