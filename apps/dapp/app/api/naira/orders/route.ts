import { isMainnet } from '@intent/config'
import { StrKey } from '@stellar/stellar-sdk'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { createLinqClient } from '../../../../lib/linq/client'
import { bankByCode } from '../../../../lib/naira/banks'
import { guardNaira } from '../../../../lib/naira/guard'
import { getNairaOrderRepo, orderNetwork, toPublic } from '../../../../lib/naira/orders'
import { normaliseStatus } from '../../../../lib/naira/status'
import { databaseConfigured } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { readSessionFromRequest } from '../../../../lib/server/session'
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

const body = z.preprocess(
  // A request with no `coin` is an XLM order: that is the only shape this route
  // took before USDC was added, and a page opened before that change still sends
  // it. Rejecting it left such a page showing a vague error with no way forward.
  (raw) =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !('coin' in raw)
      ? { ...raw, coin: 'xlm' }
      : raw,
  z.discriminatedUnion('coin', [
    z.object({ ...common, coin: z.literal('xlm'), amountNgn: z.number().positive().finite() }),
    z.object({ ...common, coin: z.literal('usdc'), amountUsdc: z.number().positive().finite() }),
  ])
)

/** What to tell the person about the first field that was refused, in their words. */
function refusalFor(path: (string | number)[]): string {
  switch (path[0]) {
    case 'account':
      return 'This wallet is not a Stellar account a payout can refund to. Connect a standard Stellar wallet.'
    case 'accountNumber':
      return 'Enter the 10-digit account number.'
    case 'bankCode':
      return 'Choose a bank.'
    case 'amountNgn':
    case 'amountUsdc':
      return 'Enter an amount greater than zero.'
    case 'idempotencyKey':
      return 'This page is out of date. Reload it and try again.'
    default:
      return 'This page is out of date. Reload it and try again.'
  }
}

/**
 * The signed-in user's cash-outs, for History.
 *
 * Only orders whose payment was sent, only this user's, only this network. It
 * answers an empty list rather than an error where cash-outs cannot exist
 * (testnet, no database), so the History page needs no special case.
 */
export async function GET(request: Request): Promise<Response> {
  const session = readSessionFromRequest(request)
  if (session === undefined) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  if (!isMainnet() || !databaseConfigured()) return NextResponse.json({ orders: [] })

  // Narrowed to the wallet that is connected. One sign-in can own several
  // wallets, and each should see only its own cash-outs. The wallet is a filter
  // on this user's own orders, never a way to reach another user's: the email
  // scope is applied first and always.
  const asked = new URL(request.url).searchParams.get('account')
  const account = asked !== null && StrKey.isValidEd25519PublicKey(asked) ? asked : undefined
  if (asked !== null && account === undefined) {
    return NextResponse.json({ orders: [] })
  }

  try {
    const repo = await getNairaOrderRepo()
    const rows = await repo.listPaidForEmail(session.email, orderNetwork(), 50, account)
    return NextResponse.json({
      orders: rows.map((row) => ({ ...toPublic(row), createdAt: row.createdAt })),
    })
  } catch {
    return NextResponse.json({ orders: [] })
  }
}

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
    const first = parsed.error.issues[0]
    return NextResponse.json(
      {
        error: 'invalid_body',
        // The field is named so a refusal can be told apart from the next one;
        // the value is never echoed back.
        ...(first !== undefined && first.path[0] !== undefined
          ? { field: String(first.path[0]) }
          : {}),
        message: refusalFor(first?.path ?? []),
      },
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
  if (existing !== undefined) {
    // An order that ended unpaid cannot be paid, and handing it back made the
    // next step fail with "no longer waiting". Said here, so the page starts a
    // new request instead of retrying this one.
    if (existing.status !== 'waiting' && existing.paymentHash === undefined) {
      return NextResponse.json(
        {
          error: 'order_closed',
          message: 'That payout ended before it was paid. Review it again to start a new one.',
        },
        { status: 409 }
      )
    }
    return NextResponse.json({ order: toPublic(existing) })
  }

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

  // The holder is taken from this user's own earlier order to the same account
  // when there is one, and from the provider's lookup otherwise. Either way it
  // is a name the provider returned, never one the browser sent.
  let accountName: string | undefined
  try {
    accountName = await repo.findHolder(guard.email, input.bankCode, input.accountNumber)
  } catch {
    // A record that cannot be read is the same as no record: ask the provider.
    accountName = undefined
  }
  if (accountName === undefined) {
    const verified = await linq.verifyBank({
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
    })
    if (!verified.ok) {
      const status = verified.code === 'rejected' ? 422 : 503
      return NextResponse.json({ error: verified.code, message: verified.message }, { status })
    }
    accountName = verified.value.accountName
  }

  const made = await linq.createOrder({
    coin: input.coin,
    ...(input.coin === 'xlm'
      ? { amountNGN: Math.round(input.amountNgn * 100) / 100 }
      : { amountStableCoin: usdc as number }),
    bankCode: input.bankCode,
    bankName: bank.name,
    bankAccount: input.accountNumber,
    accountName: accountName,
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
    accountName: accountName,
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
