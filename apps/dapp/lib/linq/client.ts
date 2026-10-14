import { createHmac, timingSafeEqual } from 'node:crypto'

import { StrKey } from '@stellar/stellar-sdk'

/**
 * Server-side client for the Linq B2B off-ramp: XLM in, naira to a bank.
 *
 * The API key can create orders that pay real naira, so this must only be
 * reached from route handlers. Nothing here is imported by a client component.
 *
 * Every order is forced to native XLM on Stellar and `manualDeposit: true`, so
 * the payout follows what actually arrives and a short payment is never a loss
 * for the operator.
 */

const DEFAULT_TIMEOUT_MS = 20_000

export type LinqFailure =
  /** The provider refused the request, with a message the user can act on. */
  | { ok: false; code: 'rejected'; message: string }
  /** The provider answered, but not with the order that was asked for. */
  | { ok: false; code: 'unexpected_order'; message: string }
  /** No answer in time. The order may exist; never report this as failed. */
  | { ok: false; code: 'unknown'; message: string }
  | { ok: false; code: 'unavailable'; message: string }

export type LinqResult<T> = { ok: true; value: T } | LinqFailure

export interface LinqOrderInput {
  /** Exact naira the recipient receives. */
  amountNGN: number
  bankCode: string
  bankName: string
  bankAccount: string
  accountName: string
  /** Where XLM returns if the payout fails. Any Stellar account can receive XLM. */
  refundAddress: string
  customerRef: string
  /** Minted once per attempt and reused on a retry, so a retry cannot double-order. */
  idempotencyKey: string
}

export interface LinqOrder {
  id: string
  /** Where the user sends XLM. Verified to be a classic Stellar account. */
  depositAddress: string
  amountXlm: number
  amountNGN: number
  /** Naira per XLM, locked for this order. */
  rate: number
  status: string
}

export interface LinqStatus {
  id: string
  status: string
  amountXlm: number
  amountNGN: number
}

export interface LinqClientOptions {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function createLinqClient(options: LinqClientOptions = {}): {
  configured: boolean
  verifyBank(input: {
    bankCode: string
    accountNumber: string
  }): Promise<LinqResult<{ accountName: string; bankName: string }>>
  /** Indicative naira per US dollar. The order locks its own rate. */
  getRate(): Promise<LinqResult<{ ngnPerUsd: number }>>
  createOrder(input: LinqOrderInput): Promise<LinqResult<LinqOrder>>
  getStatus(id: string): Promise<LinqResult<LinqStatus>>
} {
  const baseUrl = (options.baseUrl ?? process.env['LINQ_BASE_URL'] ?? '').replace(/\/$/, '')
  const apiKey = options.apiKey ?? process.env['LINQ_API_KEY'] ?? ''
  const doFetch = options.fetchImpl ?? fetch
  const configured = baseUrl !== '' && apiKey !== ''

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown }
  ): Promise<LinqResult<Record<string, unknown>>> {
    if (!configured) {
      return {
        ok: false,
        code: 'unavailable',
        message: 'Naira payouts are not available right now.',
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          'X-API-Key': apiKey,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      })

      let body: Record<string, unknown> = {}
      try {
        body = (await res.json()) as Record<string, unknown>
      } catch {
        // An empty or non-JSON body is handled by the status below.
      }

      if (res.status >= 500 || res.status === 429) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'Naira payouts are busy. Try again in a moment.',
        }
      }
      if (res.status === 401 || res.status === 403) {
        // Said as unavailable: the user cannot fix a bad key, and its name is
        // not theirs to read.
        return {
          ok: false,
          code: 'unavailable',
          message: 'Naira payouts are not available right now.',
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          code: 'rejected',
          message: str(body['message']) || 'The payout request was refused.',
        }
      }
      return { ok: true, value: body }
    } catch {
      return {
        ok: false,
        code: 'unknown',
        message: 'No answer in time. The request may have gone through; check its status.',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    configured,

    async verifyBank({ bankCode, accountNumber }) {
      const res = await call('/b2b/verifybank', {
        method: 'POST',
        body: { bankCode, accountNumber },
      })
      if (!res.ok) return res
      const accountName = str(res.value['accountName'])
      if (accountName === '') {
        return { ok: false, code: 'rejected', message: 'That account could not be verified.' }
      }
      return { ok: true, value: { accountName, bankName: str(res.value['bankName']) } }
    },

    async getRate() {
      const res = await call('/b2b/rate', { method: 'GET' })
      if (!res.ok) return res
      const ngnPerUsd = num(res.value['rate'])
      if (ngnPerUsd <= 0) {
        return { ok: false, code: 'unavailable', message: 'The rate is not available right now.' }
      }
      return { ok: true, value: { ngnPerUsd } }
    },

    async createOrder(input) {
      const res = await call('/b2b/offramp', {
        method: 'POST',
        body: {
          amountNGN: input.amountNGN,
          chain: 'stellar',
          coin: 'xlm',
          currency: 'NGN',
          manualDeposit: true,
          bankAccount: input.bankAccount,
          bankCode: input.bankCode,
          bankName: input.bankName,
          accountName: input.accountName,
          refundAddress: input.refundAddress,
          customerRef: input.customerRef,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!res.ok) return res

      // The address is what the user will send money to, so it is checked
      // against what was asked for rather than trusted: wrong chain, wrong
      // asset or a malformed address all mean funds that cannot be recovered.
      const body = res.value
      const address = str(body['walletAddress'])
      const amountXlm = num(body['amountStableCoin'])
      const matches =
        str(body['chain']).toLowerCase() === 'stellar' &&
        str(body['coin']).toLowerCase() === 'xlm' &&
        StrKey.isValidEd25519PublicKey(address) &&
        amountXlm > 0 &&
        str(body['id']) !== ''
      if (!matches) {
        return {
          ok: false,
          code: 'unexpected_order',
          message: 'The payout order did not match the request, so nothing was sent.',
        }
      }

      return {
        ok: true,
        value: {
          id: str(body['id']),
          depositAddress: address,
          amountXlm,
          amountNGN: num(body['amountNGN']),
          rate: num(body['rate']),
          status: str(body['status']),
        },
      }
    },

    async getStatus(id) {
      const res = await call(`/b2b/status?id=${encodeURIComponent(id)}`, { method: 'GET' })
      if (!res.ok) return res
      return {
        ok: true,
        value: {
          id: str(res.value['id']) || id,
          status: str(res.value['status']),
          amountXlm: num(res.value['amountStableCoin']),
          amountNGN: num(res.value['amountNGN']),
        },
      }
    },
  }
}

/**
 * Whether a webhook really came from Linq: HMAC-SHA256 of the raw body under
 * the webhook secret, `sha256=<hex>`.
 *
 * Takes the raw text, not parsed JSON — re-serialising changes the bytes.
 * Compared in constant time, and a missing secret rejects everything rather
 * than accepting anything.
 */
export function verifyLinqSignature(
  rawBody: string,
  header: string | null,
  secret: string
): boolean {
  if (secret === '' || header === null) return false
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  )
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
