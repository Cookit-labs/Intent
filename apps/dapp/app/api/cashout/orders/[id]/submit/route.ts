import { NextResponse } from 'next/server'
import { z } from 'zod'

import { ChainActionRefused, type SignedPayload } from '../../../../../../lib/chains/types'
import { logExecution } from '../../../../../../lib/server/analytics'
import { enforceRateLimit } from '../../../../../../lib/server/rate-limit'
import { reportError } from '../../../../../../lib/server/report'
import { createWeaveClient } from '../../../../../../lib/weave/client'
import { depositChain } from '../../../../../../lib/weave/deposit'
import { chainRefusal, guardCashout } from '../../../../../../lib/weave/guard'
import {
  depositExpectation,
  getWeaveOrderRepo,
  payRefusal,
  safeForReport,
  SEND_STARTED,
  syncOrder,
  type WeaveOrderRepo,
  type WeaveOrderRow,
} from '../../../../../../lib/weave/orders'
import type { CashoutChain } from '../../../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A chain's submit can poll for its confirmation: Stellar and Avalanche for about 20 to 25 seconds, Solana for about 60.
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
  z.object({ family: z.literal('evm'), hash: z.string().min(1).max(128) }),
  z.object({ family: z.literal('stellar'), signedXdr: z.string().min(1).max(262144) }),
])

const Body = z.object({ signed: Signed })

function familyOf(chain: CashoutChain): SignedPayload['family'] {
  return chain === 'avalanche' ? 'evm' : chain
}

/** These wallets send for themselves, so by the time this route hears of a transfer it has gone. */
function walletSent(signed: SignedPayload): boolean {
  return signed.family === 'near' || signed.family === 'evm'
}

function refuse(code: string, error: string, status: number): Response {
  return NextResponse.json({ ok: false, code, error }, { status })
}

/**
 * A transfer happened whatever the record says, so a database that cannot be written
 * to never changes the answer. A hash already counted does: that transfer is not a
 * payment of this order, however well it matches.
 */
async function storeHash(
  repo: WeaveOrderRepo,
  row: WeaveOrderRow,
  hash: string
): Promise<'stored' | 'reused'> {
  try {
    return await repo.setDepositHash(row.id, hash)
  } catch (e) {
    reportError('cashout/submit', safeForReport(e, row), { chain: row.chain, orderId: row.id })
    return 'stored'
  }
}

/**
 * Sends the signed deposit for an order, or for wallets that send for themselves
 * confirms what they sent.
 *
 * The order is read and asked about again: the signature took a while, and it may
 * have ended or been paid since. What the deposit must be comes from the row, and the
 * chain checks the bytes against it, because they passed through a browser and a
 * wallet extension since they were built.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'submit')
  if (limited !== undefined) return limited

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return refuse(
      'invalid_body',
      'This page is out of date. Reload it and try again. Nothing was sent.',
      400
    )
  }
  const signed = parsed.data.signed as SignedPayload

  const repo = await getWeaveOrderRepo()
  const row = await repo.getForEmail((await context.params).id, guard.email)
  if (row === undefined)
    return NextResponse.json({ ok: false, code: 'not_found', error: 'not_found' }, { status: 404 })
  const onThisNetwork = chainRefusal(row.chain)
  if (onThisNetwork !== undefined) return onThisNetwork

  if (signed.family !== familyOf(row.chain)) {
    return refuse('wrong_chain', 'This was signed for a different chain. Nothing was sent.', 400)
  }

  const sentAlready = walletSent(signed)
  const synced = await syncOrder(repo, row, createWeaveClient())
  // A wallet that sends for itself has already moved the money, and Weave may have
  // seen it by now, so this only confirms and records it whatever the order's status.
  const refused = !sentAlready || row.depositHash !== undefined ? payRefusal(synced) : undefined
  if (refused !== undefined) {
    // Saying nothing was sent would be untrue here: this wallet has already sent it.
    const tail = sentAlready
      ? 'Your wallet has already sent this transfer, so do not send it again. Check your wallet if you are unsure.'
      : 'Nothing was sent.'
    return refuse(refused.code, `${refused.reason} ${tail}`, refused.status)
  }

  // Taken before sending and kept unless the send is known to have failed, so a
  // crash, a timeout or a reload cannot lead to a second deposit.
  let claimed = false
  try {
    claimed = await repo.claimSend(row.id)
  } catch (e) {
    reportError('cashout/submit', safeForReport(e, row), { chain: row.chain, orderId: row.id })
    if (!sentAlready) {
      return refuse(
        'unavailable',
        'This deposit could not be recorded, so it was not sent. Nothing was sent. Try again in a moment.',
        503
      )
    }
  }
  if (!claimed && !sentAlready) {
    return NextResponse.json(
      { ok: false, pending: true, code: 'send_started', error: SEND_STARTED },
      { status: 409 }
    )
  }

  const release = async (): Promise<void> => {
    if (!claimed) return
    await repo.releaseSend(row.id).catch((e: unknown) => {
      reportError('cashout/submit', safeForReport(e, row), { chain: row.chain, orderId: row.id })
    })
  }

  try {
    const result = await depositChain(row.chain).submit(signed, depositExpectation(row))
    const hash = (result as { hash?: unknown }).hash
    const hashText = typeof hash === 'string' && hash !== '' ? hash : undefined
    const pending = !result.ok && result.pending === true

    const recorded =
      hashText !== undefined && (result.ok || pending)
        ? await storeHash(repo, row, hashText)
        : 'stored'
    const reused = recorded === 'reused'
    if (reused || (!result.ok && !pending)) await release()

    await logExecution({
      kind: 'offramp',
      chain: row.chain,
      account: row.account,
      feeSponsored: false,
      network: 'mainnet',
      // Sent with no outcome yet is its own thing in the numbers, not an unknown failure.
      result: reused
        ? { ok: false, reason: 'hash_reused' }
        : pending
          ? { ...result, reason: 'pending' }
          : result,
      // Off Stellar there is no envelope to read, but the deposit is the order's own USDC amount.
      ...(reused
        ? {}
        : signed.family === 'stellar'
          ? { signedXdr: signed.signedXdr }
          : {
              flow: {
                assetIn: 'USDC',
                amountIn: row.amount,
                assetOut: null,
                volumeUsd: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
              },
            }),
    })

    if (reused) {
      reportError('cashout/submit', new Error('deposit_hash_reused'), {
        chain: row.chain,
        orderId: row.id,
      })
      return refuse(
        'hash_reused',
        "This transfer is already on record as a deposit, so it does not pay this cash-out. Do not send it again. Check your wallet's activity.",
        409
      )
    }

    // The status moves only on what Weave says, so even a good answer here changes
    // nothing but the hash, and the chain's own wording reaches the person unchanged.
    return NextResponse.json(result, { status: result.ok ? 200 : pending ? 202 : 422 })
  } catch (e) {
    if (e instanceof ChainActionRefused) {
      await release()
      return NextResponse.json({ ok: false, error: e.message }, { status: 422 })
    }
    reportError('cashout/submit', safeForReport(e, row), { chain: row.chain, orderId: row.id })
    return NextResponse.json(
      {
        ok: false,
        pending: true,
        error:
          "This could not be confirmed. Check your wallet's activity before trying again, in case it went through.",
      },
      { status: 502 }
    )
  }
}
