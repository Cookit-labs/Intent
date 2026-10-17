import { isMainnet } from '@intent/config'
import { NextResponse } from 'next/server'

import { requesterOf } from '../server/requester'
import { createLinqClient } from '../linq/client'

/**
 * The checks every naira route makes before it touches money.
 *
 * A signed-in user, a mainnet deployment, and a configured provider — in that
 * order, each with its own answer, so a testnet visitor is told why rather than
 * shown a broken form.
 */
export type NairaGuard = { ok: true; email: string } | { ok: false; response: NextResponse }

export function guardNaira(request: Request): NairaGuard {
  if (!isMainnet()) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'mainnet_only',
          message: 'Naira payouts pay real money and run on Stellar mainnet only.',
        },
        { status: 403 }
      ),
    }
  }

  const who = requesterOf(request)
  if (who === undefined) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unauthenticated', message: 'Connect your wallet to cash out.' },
        { status: 401 }
      ),
    }
  }

  if (!createLinqClient().configured) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unavailable', message: 'Naira payouts are not available right now.' },
        { status: 503 }
      ),
    }
  }

  return { ok: true, email: who.email }
}
