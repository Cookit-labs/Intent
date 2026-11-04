import { isMainnet } from '@intent/config'
import { NextResponse } from 'next/server'

import { requesterOf } from '../server/requester'
import { createWeaveClient } from './client'
import type { CashoutChain } from './types'

/**
 * The checks every cash-out route makes before it touches money.
 *
 * The chain's network when it is known, a requester, and a configured provider,
 * each with its own answer. Stellar is the one chain with a testnet here, so it
 * alone depends on the network the page is on; the others are always mainnet.
 * Routes that learn the chain from the body or the stored order call
 * `chainRefusal` once they have it.
 */
export type CashoutGuard = { ok: true; email: string } | { ok: false; response: NextResponse }

export function chainRefusal(chain: CashoutChain): NextResponse | undefined {
  if (chain !== 'stellar' || isMainnet()) return undefined
  return NextResponse.json(
    {
      error: 'mainnet_only',
      message: 'Cash-outs pay real money, so on Stellar they run on mainnet only.',
    },
    { status: 403 }
  )
}

export function guardCashout(request: Request, chain?: CashoutChain): CashoutGuard {
  if (chain !== undefined) {
    const refusal = chainRefusal(chain)
    if (refusal !== undefined) return { ok: false, response: refusal }
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

  if (!createWeaveClient().configured) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unavailable', message: 'Cash-outs are not available right now.' },
        { status: 503 }
      ),
    }
  }

  return { ok: true, email: who.email }
}
