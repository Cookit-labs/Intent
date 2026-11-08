import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { createLinqClient } from '../../../../lib/linq/client'
import { databaseConfigured } from '../../../../lib/server/db'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'
import { reportError } from '../../../../lib/server/report'
import { requesterOf } from '../../../../lib/server/requester'
import { createWeaveClient, quoteCostPercent } from '../../../../lib/weave/client'
import { isCurrencyAllowed } from '../../../../lib/weave/corridors'
import { depositChain } from '../../../../lib/weave/deposit'
import { chainRefusal, guardCashout } from '../../../../lib/weave/guard'
import { placeWithLinq } from '../../../../lib/weave/linq-cashout'
import {
  cleanMemo,
  getWeaveOrderRepo,
  isPastExpiry,
  MAX_COST_PERCENT,
  orderMismatch,
  readUsdcAmount,
  safeForReport,
  toPublic,
  type WeaveOrderRow,
} from '../../../../lib/weave/orders'
import { nextStatus } from '../../../../lib/weave/status'
import { closedCashoutReply, isCashoutChain } from '../../../../lib/weave/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  chain: z.string().min(1).max(20),
  account: z.string().min(1).max(128),
  amount: z.string().min(1).max(40),
  currency: z.string().min(1).max(8),
  institution: z.string().min(1).max(64),
  accountIdentifier: z.string().regex(/^\+?[0-9A-Za-z]{6,34}$/),
  /** Minted once per attempt by the page and reused on a retry. */
  idempotencyKey: z.string().uuid(),
})

function refusal(error: string, message: string, status = 400): Response {
  return NextResponse.json({ error, message }, { status })
}

/** What to tell the person about the first field that was refused. The value is never echoed. */
function refusalFor(path: (string | number)[]): string {
  switch (path[0]) {
    case 'accountIdentifier':
      return 'Check the account number and try again.'
    case 'amount':
      return 'Enter an amount of USDC greater than zero.'
    case 'institution':
      return 'Choose where the money should go.'
    default:
      return 'This page is out of date. Reload it and try again.'
  }
}

/** This requester's cash-outs, newest first. Empty rather than an error when there is no record to read. */
export async function GET(request: Request): Promise<Response> {
  const who = requesterOf(request)
  if (who === undefined) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  if (!databaseConfigured()) return NextResponse.json({ orders: [] })
  try {
    const repo = await getWeaveOrderRepo()
    const rows = await repo.listForEmail(who.email, 50)
    return NextResponse.json({ orders: rows.map(toPublic) })
  } catch {
    return NextResponse.json({ orders: [] })
  }
}

/**
 * Creates the cash-out order and returns what the review card shows.
 *
 * The holder's name is found here and the order is made with that name, never with
 * one the browser sent: it is what the bank checks the payout against. Weave's answer
 * is checked against what was asked before it is stored or shown, and the row is
 * stored before the response, so a deposit address is never in a person's hands
 * without a record of it.
 *
 * A naira cash-out from Sui goes to Linq instead when Linq pays more, at a rate it locks.
 * Anything about Linq's order that can't be confirmed leaves the cash-out with Weave.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardCashout(request)
  if (!guard.ok) return guard.response
  const limited = await enforceRateLimit(request, 'build')
  if (limited !== undefined) return limited

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return refusal('invalid_body', refusalFor(parsed.error.issues[0]?.path ?? []))
  }
  const input = parsed.data

  const { chain } = input
  if (!isCashoutChain(chain)) {
    return refusal('unknown_chain', 'Cash-outs are not available on this chain.')
  }
  // The chat refuses this before any form opens. A page left open from before it did can still post.
  const closed = closedCashoutReply(chain)
  if (closed !== undefined) return refusal('chain_closed', closed, 422)
  const onThisNetwork = chainRefusal(chain)
  if (onThisNetwork !== undefined) return onThisNetwork

  const deposit = depositChain(chain)
  const amount = readUsdcAmount(input.amount, deposit.usdcDecimals)
  if (amount === undefined) {
    return refusal(
      'invalid_amount',
      `Enter an amount of USDC greater than zero, with at most ${deposit.usdcDecimals} decimal places.`
    )
  }
  if (!deposit.isAccount(input.account)) {
    return refusal('invalid_account', 'This wallet cannot make a deposit on this chain.')
  }
  const { currency } = input
  if (!isCurrencyAllowed(chain, currency)) {
    return refusal('unknown_currency', 'This chain does not cash out to that currency.')
  }

  const repo = await getWeaveOrderRepo().catch(() => undefined)
  const existing = await repo
    ?.getByIdempotencyKey(input.idempotencyKey, guard.email)
    .then((row) => ({ found: row }))
    .catch(() => undefined)
  // With no record to write to, no order may be made: the address could not be kept.
  if (repo === undefined || existing === undefined) {
    return refusal(
      'unavailable',
      'Cash-outs are not available right now. Nothing was signed or sent.',
      503
    )
  }

  // A retry of the same attempt returns the order already made, not a second.
  if (existing.found !== undefined) {
    const row = existing.found
    // An order that ended unpaid cannot be paid. The page starts a new attempt on this code.
    if (row.depositHash === undefined && (row.status !== 'waiting' || isPastExpiry(row))) {
      return refusal(
        'order_closed',
        'That cash-out ended before it was paid. Review it again to start a new one.',
        409
      )
    }
    return NextResponse.json({ order: toPublic(row) })
  }

  // A reload forgets what the page knew, so this is asked of the record: a person who
  // can't see their earlier deposit must not be led to pay for the same thing again.
  const unconfirmed = await repo.hasUnconfirmedSend(input.account).catch(() => undefined)
  if (unconfirmed !== false) {
    return refusal(
      unconfirmed === undefined ? 'unavailable' : 'send_unconfirmed',
      unconfirmed === undefined
        ? 'Cash-outs are not available right now. Nothing was sent.'
        : 'An earlier deposit from this wallet is not confirmed yet. Wait for it to settle before starting another. Nothing new was sent.',
      unconfirmed === undefined ? 503 : 409
    )
  }

  const weave = createWeaveClient()
  const fail = (code: string, message: string): Response =>
    refusal(code, message, code === 'rejected' ? 422 : 503)

  const listed = await weave.institutions(currency)
  if (!listed.ok) return fail(listed.code, listed.message)
  const institution = listed.value.find((i) => i.code === input.institution)
  if (institution === undefined) {
    return refusal(
      'unknown_institution',
      'That bank or service is not available for this currency.'
    )
  }

  // The holder is taken from this requester's own earlier order to the same account
  // when there is one, and from Weave's lookup otherwise. Either way it is a name
  // Weave returned, never one the browser sent.
  let accountName = await repo
    .findHolder(guard.email, currency, input.institution, input.accountIdentifier)
    .catch(() => undefined)
  if (accountName === undefined) {
    const verified = await weave.verifyAccount({
      institution: input.institution,
      accountIdentifier: input.accountIdentifier,
      currency,
    })
    if (!verified.ok) return fail(verified.code, verified.message)
    accountName = verified.value.accountName
  }

  const record = async (
    row: Omit<WeaveOrderRow, 'depositHash' | 'sendStarted' | 'createdAt'>
  ): Promise<Response> => {
    try {
      await repo.insert(row)
    } catch (e) {
      reportError('cashout/orders', safeForReport(e, row), {
        chain,
        currency,
        providerOrder: row.providerOrder,
      })
      return refusal(
        'not_recorded',
        'This cash-out could not be recorded, so nothing was signed or sent. Review it again to start a new one.',
        503
      )
    }
    return NextResponse.json({
      order: toPublic({
        ...row,
        depositHash: undefined,
        sendStarted: false,
        createdAt: new Date().toISOString(),
      }),
    })
  }

  const quote = await weave.quote({ chain, currency, amount })
  const weaveCost = quote.ok ? quoteCostPercent(amount, quote.value.netUsd) : undefined
  const viaLinq = await placeWithLinq({
    linq: createLinqClient(),
    chain,
    currency,
    amount,
    weaveNaira:
      quote.ok && weaveCost !== undefined && weaveCost <= MAX_COST_PERCENT
        ? quote.value.destAmount
        : undefined,
    institutionName: institution.name,
    accountIdentifier: input.accountIdentifier,
    accountName,
    refundAddress: input.account,
    customerRef: guard.email,
    idempotencyKey: input.idempotencyKey,
  })
  if ('placed' in viaLinq) {
    const order = viaLinq.placed
    return record({
      id: randomUUID(),
      chain,
      email: guard.email,
      account: input.account,
      providerOrder: order.id,
      provider: 'linq',
      idempotencyKey: input.idempotencyKey,
      currency,
      institutionCode: input.institution,
      institutionName: institution.name,
      accountIdentifier: input.accountIdentifier,
      accountName,
      depositAddress: order.depositAddress,
      depositMemo: undefined,
      // Linq's client has held the order to exactly this amount of USDC.
      amount,
      // The naira Linq locked for this order: what reaches the account, not an estimate.
      estimatedDest: String(order.amountNGN),
      expiresAt: undefined,
      status: 'waiting',
      providerStatus: order.status,
    })
  }
  if (viaLinq.skipped === 'order_unknown' || viaLinq.skipped === 'order_unexpected') {
    reportError('cashout/orders', new Error(`linq_${viaLinq.skipped}`), { chain, currency })
  }

  if (!quote.ok) return fail(quote.code, quote.message)
  if (weaveCost !== undefined && weaveCost > MAX_COST_PERCENT) {
    return refusal(
      'too_costly',
      `This cash-out would cost more than ${MAX_COST_PERCENT}% of the amount right now, so it was not started. Nothing was signed or sent.`,
      422
    )
  }

  const made = await weave.createOrder({
    chain,
    currency,
    amount,
    account: input.account,
    institutionCode: input.institution,
    accountIdentifier: input.accountIdentifier,
    accountName,
    reference: input.idempotencyKey,
    customer: guard.email.startsWith('wallet:')
      ? { externalId: guard.email }
      : { email: guard.email },
  })
  if (!made.ok) {
    if (made.code === 'duplicate') {
      // Weave has an order this app has no record of, and its deposit address was
      // never shown to anyone. The page starts a new attempt on this code.
      return refusal('order_closed', made.message, 409)
    }
    if (made.code === 'unknown' || made.code === 'unexpected') {
      reportError('cashout/orders', new Error(`order_${made.code}`), { chain, currency })
    }
    const status =
      made.code === 'rejected'
        ? 422
        : made.code === 'unknown'
          ? 504
          : made.code === 'unexpected'
            ? 502
            : 503
    return refusal(made.code, made.message, status)
  }

  const order = made.value
  const mismatch = orderMismatch(order, { chain, currency, amount }, deposit)
  if (mismatch !== undefined) {
    reportError('cashout/orders', new Error('order_mismatch'), {
      chain,
      currency,
      field: mismatch,
      providerOrder: order.id,
    })
    return refusal(
      'unexpected_order',
      'The cash-out order did not match the request, so nothing was signed or sent.',
      502
    )
  }

  return record({
    id: randomUUID(),
    chain,
    email: guard.email,
    account: input.account,
    providerOrder: order.id,
    provider: 'weave',
    idempotencyKey: input.idempotencyKey,
    currency,
    institutionCode: input.institution,
    institutionName: institution.name,
    accountIdentifier: input.accountIdentifier,
    accountName,
    depositAddress: order.deposit.address,
    depositMemo: cleanMemo(order.deposit.memo),
    // What Weave needs to receive, which can be a little over what was asked. This
    // is what the person signs, and orderMismatch has already bounded it.
    amount: readUsdcAmount(order.deposit.amount.trim(), deposit.usdcDecimals) as string,
    estimatedDest: String(quote.value.destAmount),
    expiresAt: order.deposit.expiresAt,
    status: nextStatus('waiting', order.status),
    providerStatus: order.status,
  })
}
