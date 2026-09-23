import { StrKey } from '@stellar/stellar-sdk'
import { NextResponse } from 'next/server'

import { beginKeySession, completeKeySession } from '../../../../lib/perps/key-session'
import { createNoetherClient } from '../../../../lib/perps/noether-client'

/**
 * The Noether API-key handshake, in two halves around the wallet prompt.
 *
 * GET asks whether this wallet may have a key, fetches the gateway's
 * challenge and wraps it as the unsubmittable transaction the wallet will
 * sign. POST verifies the signed copy and exchanges it for the key, which the
 * browser then holds for the tab. The server holds no key at any point: the
 * credential is the wallet's, like the SEP-10 token.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_FOR: Record<string, number> = {
  not_in_beta: 403,
  offline: 502,
  refused: 400,
  key_limit_reached: 409,
}

export async function GET(request: Request): Promise<NextResponse> {
  const account = new URL(request.url).searchParams.get('account') ?? ''
  if (!StrKey.isValidEd25519PublicKey(account)) {
    return NextResponse.json({ error: 'account must be a Stellar public key' }, { status: 400 })
  }
  const out = await beginKeySession({ client: createNoetherClient(), account })
  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, code: out.code },
      { status: STATUS_FOR[out.code] ?? 502 }
    )
  }
  return NextResponse.json({
    xdr: out.xdr,
    challengeHex: out.challengeHex,
    expiresAt: out.expiresAt,
  })
}

interface Body {
  account?: unknown
  challengeHex?: unknown
  signedXdr?: unknown
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  for (const key of ['account', 'challengeHex', 'signedXdr'] as const) {
    if (typeof body[key] !== 'string' || body[key] === '') {
      return NextResponse.json({ error: `${key} is required` }, { status: 400 })
    }
  }
  const account = body.account as string
  if (!StrKey.isValidEd25519PublicKey(account)) {
    return NextResponse.json({ error: 'account must be a Stellar public key' }, { status: 400 })
  }

  const out = await completeKeySession({
    client: createNoetherClient(),
    account,
    challengeHex: body.challengeHex as string,
    signedXdr: body.signedXdr as string,
  })
  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, code: out.code },
      { status: STATUS_FOR[out.code] ?? 502 }
    )
  }
  return NextResponse.json({ key: out.key })
}
