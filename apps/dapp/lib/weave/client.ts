import { z } from 'zod'

import { weaveAssetKey, type CashoutChain } from './types'

/**
 * Server-side client for Weave: USDC in on five chains, local currency to a bank
 * or mobile money account.
 *
 * The key can create orders that pay real money, so this must only be reached from
 * route handlers. Weave's docs are known to be out of date, so every answer is read
 * through a schema and anything else fails closed. Its failure text names its own
 * providers and is never passed on: each failure below carries a sentence of ours.
 */

const BASE_URL = 'https://api.paywithweave.com/api/v1'
const DEFAULT_TIMEOUT_MS = 20_000

export type WeaveFailure =
  /** Weave refused the request. */
  | { ok: false; code: 'rejected'; message: string }
  /** Weave answered, but not in a shape this client can trust. */
  | { ok: false; code: 'unexpected'; message: string }
  /** The reference on an order was already used. */
  | { ok: false; code: 'duplicate'; message: string }
  /** An order was sent and no clear answer came back. It may exist. */
  | { ok: false; code: 'unknown'; message: string }
  | { ok: false; code: 'unavailable'; message: string }

export type WeaveResult<T> = { ok: true; value: T } | WeaveFailure

export interface WeaveInstitution {
  name: string
  code: string
  type: 'bank' | 'mobile_money'
}

export interface WeaveQuote {
  destAmount: number
  /** What is left in dollars after every fee. The cost is worked out from this. */
  netUsd: number
  seconds: number
}

export interface WeaveOrderInput {
  chain: CashoutChain
  currency: string
  /** USDC in display units. */
  amount: string
  /** The wallet paying the deposit, which is also where a refund goes. */
  account: string
  institutionCode: string
  accountIdentifier: string
  accountName: string
  /** The attempt's idempotency key. Weave answers 409 to a second order with the same one. */
  reference: string
  customer: { email?: string; name?: string; externalId?: string }
}

export interface WeaveDeposit {
  address: string
  memo: string | undefined
  amount: string
  token: string
  chain: string
  expiresAt?: string
}

export interface WeaveOrder {
  id: string
  status: string
  sourceAssetKey?: string
  destAssetKey?: string
  deposit: WeaveDeposit
}

export interface WeaveOrderState {
  id: string
  status: string
}

export interface WeaveClientOptions {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface WeaveClient {
  configured: boolean
  institutions(currency: string): Promise<WeaveResult<WeaveInstitution[]>>
  verifyAccount(input: {
    institution: string
    accountIdentifier: string
    currency: string
  }): Promise<WeaveResult<{ accountName: string }>>
  quote(input: {
    chain: CashoutChain
    currency: string
    amount: string
  }): Promise<WeaveResult<WeaveQuote>>
  createOrder(input: WeaveOrderInput): Promise<WeaveResult<WeaveOrder>>
  getOrder(id: string): Promise<WeaveResult<WeaveOrderState>>
}

const UNAVAILABLE = 'Cash-outs are not available right now. No money has moved.'
const BUSY = 'Cash-outs are busy right now. No money has moved. Try again in a moment.'
const UNREADABLE = 'The cash-out service gave an answer that could not be read. No money has moved.'

const Institutions = z.array(
  z.object({
    name: z.string().min(1),
    code: z.string().min(1),
    type: z.enum(['bank', 'mobile_money']),
  })
)

const Quote = z.object({
  estimatedDest: z.number().finite().positive(),
  breakdown: z.object({ netUsd: z.number().finite() }),
  route: z.object({ totalExpectedSecs: z.number().finite().nonnegative() }),
})

const Deposit = z.object({
  depositAddress: z.string().min(1),
  depositMemo: z.string().nullish(),
  amount: z.union([z.string().min(1), z.number().finite()]),
  token: z.string().min(1),
  chain: z.string().min(1),
  expiresAt: z
    .string()
    .refine((text) => !Number.isNaN(Date.parse(text)))
    .nullish(),
})

const Placed = z.object({
  order: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    sourceAssetKey: z.string().optional(),
    destAssetKey: z.string().optional(),
  }),
  depositInstruction: Deposit.nullish(),
  nextAction: Deposit.nullish(),
})

const OrderState = z.object({ id: z.string().min(1).optional(), status: z.string().min(1) })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The docs disagree on whether an order sits under `data`, so either is read. */
function unwrap(body: unknown): unknown {
  return isRecord(body) && 'data' in body ? body['data'] : body
}

/**
 * Reads Weave's answer to placing an order, or nothing if it is not one. No real
 * order has been placed yet, so this shape is unconfirmed, and this is the one
 * function to fix when the first real answer differs. `depositInstruction` may be
 * absent with only `nextAction`, which carries no expiry.
 */
export function parsePlacedOrder(body: unknown): WeaveOrder | undefined {
  const parsed = Placed.safeParse(unwrap(body))
  if (!parsed.success) return undefined
  const { order, depositInstruction, nextAction } = parsed.data
  const deposit = depositInstruction ?? nextAction
  if (deposit === null || deposit === undefined) return undefined
  return {
    id: order.id,
    status: order.status,
    ...(order.sourceAssetKey === undefined ? {} : { sourceAssetKey: order.sourceAssetKey }),
    ...(order.destAssetKey === undefined ? {} : { destAssetKey: order.destAssetKey }),
    deposit: {
      address: deposit.depositAddress,
      memo:
        deposit.depositMemo === null ||
        deposit.depositMemo === undefined ||
        deposit.depositMemo === ''
          ? undefined
          : deposit.depositMemo,
      amount: String(deposit.amount),
      token: deposit.token,
      chain: deposit.chain,
      ...(deposit.expiresAt === null || deposit.expiresAt === undefined
        ? {}
        : { expiresAt: deposit.expiresAt }),
    },
  }
}

/**
 * The share of the amount lost on the way to `netUsd`. Weave's own
 * `totalExpectedFeeBps` does not match what it really deducts, so it is not used.
 * An amount that cannot be read costs more than any limit, so it is refused.
 */
export function quoteCostPercent(amount: string, netUsd: number): number {
  const asked = Number(amount)
  if (!Number.isFinite(asked) || asked <= 0) return Number.POSITIVE_INFINITY
  return ((asked - netUsd) / asked) * 100
}

export function createWeaveClient(options: WeaveClientOptions = {}): WeaveClient {
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, '')
  const apiKey = options.apiKey ?? process.env['WEAVE_SECRET_KEY'] ?? ''
  const doFetch = options.fetchImpl ?? fetch
  const configured = apiKey !== ''

  async function send(
    path: string,
    method: 'GET' | 'POST',
    payload?: unknown
  ): Promise<{ status: number; body: unknown } | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'x-secret-key': apiKey,
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      })
      const body: unknown = await res.json().catch(() => undefined)
      return { status: res.status, body }
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** One read: the contents of `{ success: true, data }`, or a failure saying what happened. */
  async function read(
    path: string,
    refusal: string,
    method: 'GET' | 'POST' = 'GET',
    payload?: unknown
  ): Promise<{ ok: true; value: unknown } | WeaveFailure> {
    if (!configured) return { ok: false, code: 'unavailable', message: UNAVAILABLE }
    const res = await send(path, method, payload)
    if (res === undefined) return { ok: false, code: 'unavailable', message: BUSY }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'unavailable', message: UNAVAILABLE }
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, code: 'unavailable', message: BUSY }
    }
    const success = isRecord(res.body) ? res.body['success'] : undefined
    if (res.status >= 400 || success === false) {
      return { ok: false, code: 'rejected', message: refusal }
    }
    if (success !== true || !isRecord(res.body)) {
      return { ok: false, code: 'unexpected', message: UNREADABLE }
    }
    return { ok: true, value: res.body['data'] }
  }

  return {
    configured,

    async institutions(currency) {
      const res = await read(
        `/institutions?currency=${encodeURIComponent(currency)}`,
        'The list of banks for this currency could not be loaded.'
      )
      if (!res.ok) return res
      const parsed = Institutions.safeParse(res.value)
      if (!parsed.success) return { ok: false, code: 'unexpected', message: UNREADABLE }
      return { ok: true, value: parsed.data }
    },

    async verifyAccount({ institution, accountIdentifier, currency }) {
      const res = await read(
        '/institutions/verify',
        'That account could not be verified. Check the details and try again.',
        'POST',
        { institution, accountIdentifier, currency }
      )
      if (!res.ok) return res
      if (typeof res.value !== 'string' || res.value.trim() === '') {
        return { ok: false, code: 'unexpected', message: UNREADABLE }
      }
      return { ok: true, value: { accountName: res.value.trim() } }
    },

    async quote({ chain, currency, amount }) {
      const query = new URLSearchParams({
        from: weaveAssetKey(chain),
        to: `fiat:${currency}`,
        amount,
      })
      const res = await read(
        `/quotes?${query.toString()}`,
        'No price is available for this cash-out right now. No money has moved.'
      )
      if (!res.ok) return res
      const parsed = Quote.safeParse(res.value)
      if (!parsed.success) return { ok: false, code: 'unexpected', message: UNREADABLE }
      return {
        ok: true,
        value: {
          destAmount: parsed.data.estimatedDest,
          netUsd: parsed.data.breakdown.netUsd,
          seconds: parsed.data.route.totalExpectedSecs,
        },
      }
    },

    async createOrder(input) {
      if (!configured) return { ok: false, code: 'unavailable', message: UNAVAILABLE }
      const res = await send('/orders', 'POST', {
        source: {
          inline: {
            kind: 'crypto_wallet',
            assetKey: weaveAssetKey(input.chain),
            walletAddress: input.account,
          },
        },
        dest: {
          inline: {
            kind: 'bank_account',
            assetKey: `fiat:${input.currency}`,
            bankInstitution: input.institutionCode,
            bankAccountIdentifier: input.accountIdentifier,
            bankAccountName: input.accountName,
            label: 'Cash-out',
          },
        },
        amount: input.amount,
        amountIn: 'source',
        flow: 'external',
        refundAddress: input.account,
        reference: input.reference,
        customer: input.customer,
      })

      const unknown = 'No clear answer came back. Nothing was signed or sent from your wallet.'
      if (res === undefined || res.status >= 500) {
        return { ok: false, code: 'unknown', message: unknown }
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'unavailable', message: UNAVAILABLE }
      }
      if (res.status === 429) return { ok: false, code: 'unavailable', message: BUSY }
      if (res.status === 409) {
        return {
          ok: false,
          code: 'duplicate',
          message: 'This attempt could not be confirmed. Review it again to start a new one.',
        }
      }
      if (res.status >= 400 || (isRecord(res.body) && res.body['success'] === false)) {
        return {
          ok: false,
          code: 'rejected',
          message: 'The cash-out could not be started. Nothing was signed or sent.',
        }
      }

      const order = parsePlacedOrder(res.body)
      if (order === undefined) {
        return {
          ok: false,
          code: 'unexpected',
          message: 'The cash-out could not be started. Nothing was signed or sent.',
        }
      }
      return { ok: true, value: order }
    },

    async getOrder(id) {
      const res = await read(
        `/orders/${encodeURIComponent(id)}`,
        'The status of this cash-out could not be read.'
      )
      if (!res.ok) return res
      const inner = isRecord(res.value) && 'order' in res.value ? res.value['order'] : res.value
      const parsed = OrderState.safeParse(inner)
      if (!parsed.success || (parsed.data.id !== undefined && parsed.data.id !== id)) {
        return { ok: false, code: 'unexpected', message: UNREADABLE }
      }
      return { ok: true, value: { id, status: parsed.data.status } }
    },
  }
}
