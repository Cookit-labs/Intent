import { CHAIN_DESCRIPTORS } from '@intent/config'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { chainModule } from '../../../../../lib/chains/registry'
import { ChainActionRefused, type SigningPayload } from '../../../../../lib/chains/types'
import { logExecution } from '../../../../../lib/server/analytics'
import { enforceRateLimit } from '../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../lib/server/report'
import { isWalletAddress } from '../../../../../lib/wallet/address'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A send waits for the network to confirm, and a 1Click swap then waits on 1Click too.
export const maxDuration = 60

const Signed = z.discriminatedUnion('family', [
  z.object({ family: z.literal('solana'), signedTransaction: z.string().min(1).max(8192) }),
  z.object({
    family: z.literal('sui'),
    transaction: z.string().min(1).max(262144),
    signature: z.string().min(1).max(1024),
  }),
  z.object({
    family: z.literal('near'),
    hashes: z.array(z.string().min(1).max(128)).min(1).max(8),
  }),
  // The venue checks its shape, so an odd answer from a wallet that may have sent is read as pending.
  z.object({ family: z.literal('evm'), hash: z.string().max(128) }),
  z.object({ family: z.literal('evm-typed'), signature: z.string().min(1).max(200) }),
])

const Body = z.object({
  account: z.string().min(1).max(128),
  venueId: z.string().min(1).max(40),
  signed: Signed,
  context: z.record(z.string().max(2048)).optional(),
})

/**
 * Re-checks signed bytes before sending them. Signed bytes come from the browser,
 * so what they do is checked again here and never taken from what was prepared.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

  const chainApi = chainModule((await params).chain)
  if (chainApi === undefined) return NextResponse.json({ error: 'unknown_chain' }, { status: 404 })

  const parsed = Body.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const { account, venueId, signed, context } = parsed.data
  if (!isWalletAddress(account)) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  const venue = chainApi.venues.find((v) => v.id === venueId)
  if (venue === undefined) return NextResponse.json({ error: 'unknown_venue' }, { status: 404 })
  // By family, since Avalanche and Monad are both EVM. A typed message is EVM's too.
  const family = signed.family === 'evm-typed' ? 'evm' : signed.family
  if (family !== CHAIN_DESCRIPTORS[chainApi.chain].family) {
    return NextResponse.json({ error: 'wrong_chain' }, { status: 400 })
  }

  // NEAR and EVM wallets have already sent, so there are no bytes left to check. Their venues
  // ask the chain what was sent instead. A typed message carries only its signature, so its venue
  // rebuilds what was signed and checks it before posting anything.
  if (signed.family === 'solana' || signed.family === 'sui') {
    const payload: SigningPayload =
      signed.family === 'solana'
        ? { family: 'solana', transaction: signed.signedTransaction }
        : { family: 'sui', transaction: signed.transaction }
    try {
      venue.assertSafe(payload, account, context)
    } catch (e) {
      // This route is what sends the bytes, so any failure here means they never left.
      if (e instanceof ChainActionRefused) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 422 })
      }
      reportError('chain/submit', e, { chain: chainApi.chain })
      return NextResponse.json(
        {
          ok: false,
          error: 'This transaction could not be checked, so nothing was sent. Build it again.',
        },
        { status: 422 }
      )
    }
  }

  try {
    const input = { account, venueId, signed, ...(context !== undefined ? { context } : {}) }
    const result = await (venue.submit ?? chainApi.submit)(input)
    await logExecution({
      kind: chainApi.chain,
      account,
      feeSponsored: false,
      network: 'mainnet',
      // Sent with no outcome yet is its own thing in the numbers, not an unknown failure.
      result: !result.ok && result.pending === true ? { ...result, reason: 'pending' } : result,
    })
    return NextResponse.json(result, {
      status: result.ok ? 200 : result.pending === true ? 202 : 422,
    })
  } catch (e) {
    reportError('chain/submit', e, { chain: chainApi.chain })
    return NextResponse.json(
      {
        ok: false,
        // Sending may have started, so no throw from here on can prove nothing moved.
        // Sent with no outcome known: the same contract as the cash-out route.
        pending: true,
        error:
          "This could not be confirmed. Check your wallet's activity before trying again, in case it went through.",
      },
      { status: 202 }
    )
  }
}
