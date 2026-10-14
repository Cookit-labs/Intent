import { StrKey } from '@stellar/stellar-sdk'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { createLinqClient } from '../../../../lib/linq/client'
import { bankByCode } from '../../../../lib/naira/banks'
import { guardNaira } from '../../../../lib/naira/guard'
import { getNairaOrderRepo, orderNetwork, toPublic } from '../../../../lib/naira/orders'
import { normaliseStatus } from '../../../../lib/naira/status'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { fromBaseUnits, toBaseUnits } from '../../../../lib/swap/assets'
import { balanceOf } from '../../../../lib/swap/delivered-balance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Per-order ceiling in naira, so one mistake or one stolen session is bounded. */
function maxNgn(): number {
  const raw = Number(process.env['NAIRA_MAX_NGN'])
  return Number.isFinite(raw) && raw > 0 ? raw : 200_000
}

const common = {
  account: z.string().refine((a) => StrKey.isValidEd25519PublicKey(a)),
  bankCode: z.string().min(1).max(10),
  accountNumber: z.string().regex(/^\d{10}$/),
  /** Minted once per attempt by the page and reused on a retry. */
  idempotencyKey: z.string().uuid(),
}

const body = z.discriminatedUnion('coin', [
  z.object({ ...common, coin: z.literal('xlm'), amountNgn: z.number().positive().finite() }),
  z.object({ ...common, coin: z.literal('usdc'), amountUsdc: z.number().positive().finite() }),
])

function overLimit(): Response {
  return NextResponse.json(
    {
      error: 'over_limit',
      message: `One payout is limited to ₦${maxNgn().toLocaleString('en-US')}.`,
    },
    { status: 400 }
  )
}

/**
 * Creates the payout order and returns what the review card shows.
 *
 * The holder's name is looked up *here* and the order is made with that name,
 * never with one the browser sent: the name is what the bank checks the payout
 * against, and a page that could choose it could choose a mismatch. The row is
 * stored before the response, so a deposit address is never in the user's hands
 * without a record of it.
 *
 * An XLM order is sized by the naira the user wants. A USDC order follows a
 * swap, so it is sized by the USDC actually in hand; the browser reports that
 * figure because Horizon does not expose a router's output, and it is bounded
 * here by the account's real balance. A figure that is too high cannot be paid
 * and one that is too low only pays the user less.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardNaira(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Check the amount and the account number.' },
      { status: 400 }
    )
  }
  const input = parsed.data

  const bank = bankByCode(input.bankCode)
  if (bank === undefined) {
    return NextResponse.json(
      { error: 'unknown_bank', message: 'That bank is not supported.' },
      { status: 400 }
    )
  }

  const repo = await getNairaOrderRepo()

  // A retry of the same attempt returns the order already made, not a second.
  const existing = await repo.getByIdempotencyKey(input.idempotencyKey, guard.email)
  if (existing !== undefined) return NextResponse.json({ order: toPublic(existing) })

  const linq = createLinqClient()

  // What is being deposited, checked before the provider is asked for anything.
  let usdc: number | undefined
  if (input.coin === 'usdc') {
    // Rounded down to the ledger's seven places, so the figure is one an
    // account can actually hold and pay.
    usdc = Math.floor(input.amountUsdc * 1e7) / 1e7
    if (usdc <= 0) {
      return NextResponse.json(
        { error: 'invalid_body', message: 'That USDC amount is too small.' },
        { status: 400 }
      )
    }

    const held = await balanceOf(input.account, 'USDC').catch(() => undefined)
    if (held !== undefined && BigInt(toBaseUnits(usdc.toFixed(7))) > held) {
      return NextResponse.json(
        {
          error: 'insufficient',
          message: `That is more USDC than the account holds (${fromBaseUnits(held.toString())}).`,
        },
        { status: 409 }
      )
    }

    // The refund goes to the account itself, so it must be able to receive USDC.
    const trust = await linq.hasUsdcTrustline(input.account)
    if (!trust.ok) {
      const status = trust.code === 'rejected' ? 422 : 503
      return NextResponse.json({ error: trust.code, message: trust.message }, { status })
    }
    if (trust.value.trusts === false) {
      return NextResponse.json(
        { error: 'no_trustline', message: 'This account cannot receive USDC refunds yet.' },
        { status: 409 }
      )
    }

    // The cap is on naira, which a USDC order only learns once it is made, so
    // it is estimated from the indicative rate first.
    const rate = await linq.getRate()
    if (!rate.ok) {
      return NextResponse.json({ error: rate.code, message: rate.message }, { status: 503 })
    }
    if (usdc * rate.value.ngnPerUsd > maxNgn()) return overLimit()
  } else if (input.amountNgn > maxNgn()) {
    return overLimit()
  }

  const verified = await linq.verifyBank({
    bankCode: input.bankCode,
    accountNumber: input.accountNumber,
  })
  if (!verified.ok) {
    const status = verified.code === 'rejected' ? 422 : 503
    return NextResponse.json({ error: verified.code, message: verified.message }, { status })
  }

  const made = await linq.createOrder({
    coin: input.coin,
    ...(input.coin === 'xlm'
      ? { amountNGN: Math.round(input.amountNgn * 100) / 100 }
      : { amountStableCoin: usdc as number }),
    bankCode: input.bankCode,
    bankName: bank.name,
    bankAccount: input.accountNumber,
    accountName: verified.value.accountName,
    refundAddress: input.account,
    customerRef: guard.email,
    idempotencyKey: input.idempotencyKey,
  })
  if (!made.ok) {
    // An unknown outcome is said as unknown: the order may exist, and the page
    // retries with the same key rather than starting over.
    const status = made.code === 'rejected' ? 422 : made.code === 'unknown' ? 504 : 502
    return NextResponse.json({ error: made.code, message: made.message }, { status })
  }

  const order = made.value
  const row = {
    id: randomUUID(),
    network: orderNetwork(),
    email: guard.email,
    account: input.account,
    providerOrder: order.id,
    idempotencyKey: input.idempotencyKey,
    bankCode: input.bankCode,
    bankName: bank.name,
    accountNumber: input.accountNumber,
    accountName: verified.value.accountName,
    depositAddress: order.depositAddress,
    coin: order.coin,
    // Seven places, never exponent notation: this string becomes a payment amount.
    amount: order.amountCoin.toFixed(7),
    amountNgn: String(order.amountNGN),
    rate: String(order.rate),
    status: normaliseStatus(order.status),
    providerStatus: order.status,
  }
  await repo.insert(row)

  return NextResponse.json({
    order: toPublic({ ...row, paymentHash: undefined, createdAt: new Date().toISOString() }),
  })
}
