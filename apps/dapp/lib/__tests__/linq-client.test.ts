import { createHmac } from 'node:crypto'

import { Keypair } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { createLinqClient, verifyLinqSignature } from '../linq/client'

const DEPOSIT = Keypair.random().publicKey()
const REFUND = Keypair.random().publicKey()

interface Seen {
  url: string
  init: { method?: string; headers: Record<string, string>; body?: string }
}

function server(respond: (seen: Seen) => { status: number; body: unknown } | Promise<never>): {
  fetchImpl: typeof fetch
  calls: Seen[]
} {
  const calls: Seen[] = []
  const fetchImpl = ((url: string, init: Seen['init']) => {
    const seen = { url, init }
    calls.push(seen)
    const out = respond(seen)
    if (out instanceof Promise) return out
    return Promise.resolve(
      new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const config = { baseUrl: 'https://linq.test', apiKey: 'biz_live_test' }

const orderInput = {
  coin: 'xlm' as const,
  amountNGN: 2000,
  bankCode: '033',
  bankName: 'United Bank for Africa',
  bankAccount: '1234567890',
  accountName: 'John Doe',
  refundAddress: REFUND,
  customerRef: 'user_1',
  idempotencyKey: 'key-1',
}

// A USDC order carries no naira amount: it is sized by the USDC in hand.
const { amountNGN: _naira, ...withoutNaira } = orderInput
const usdcBase = { ...withoutNaira, coin: 'usdc' as const }

function goodOrder(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'ord-1',
    walletAddress: DEPOSIT,
    coinType: '',
    coin: 'xlm',
    chain: 'stellar',
    amountStableCoin: 6,
    amountNGN: 2000,
    rate: 333.33,
    currency: 'NGN',
    status: 'initiated',
    ...overrides,
  }
}

describe('linq client', () => {
  it('verifies a bank account with the key header and returns the holder name', async () => {
    const { fetchImpl, calls } = server(() => ({
      status: 200,
      body: {
        accountName: 'John Doe',
        bankName: 'UBA',
        accountNumber: '1234567890',
        bankCode: '033',
      },
    }))
    const result = await createLinqClient({ ...config, fetchImpl }).verifyBank({
      bankCode: '033',
      accountNumber: '1234567890',
    })
    expect(result).toEqual({ ok: true, value: { accountName: 'John Doe', bankName: 'UBA' } })
    expect(calls[0]?.url).toBe('https://linq.test/b2b/verifybank')
    expect(calls[0]?.init.headers['X-API-Key']).toBe('biz_live_test')
  })

  it('always creates a native XLM order on Stellar that follows the deposit', async () => {
    const { fetchImpl, calls } = server(() => ({ status: 201, body: goodOrder() }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder(orderInput)
    expect(result.ok).toBe(true)

    const sent = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    expect(sent).toMatchObject({
      chain: 'stellar',
      coin: 'xlm',
      currency: 'NGN',
      manualDeposit: true,
      amountNGN: 2000,
      idempotencyKey: 'key-1',
    })
    expect(sent).not.toHaveProperty('amountStableCoin')
  })

  it('orders USDC by the amount in hand and sends no naira amount', async () => {
    const { fetchImpl, calls } = server(() => ({
      status: 201,
      body: goodOrder({ coin: 'usdc', coinType: 'USDC:GA5Z', amountStableCoin: 29.87 }),
    }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder({
      ...usdcBase,
      amountStableCoin: 29.87,
    })
    expect(result).toMatchObject({ ok: true, value: { coin: 'usdc', amountCoin: 29.87 } })
    const sent = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
    expect(sent).toMatchObject({ coin: 'usdc', amountStableCoin: 29.87, manualDeposit: true })
    expect(sent).not.toHaveProperty('amountNGN')
  })

  it('refuses a USDC order that comes back as XLM, and an order with no amount', async () => {
    const wrong = server(() => ({ status: 201, body: goodOrder({ coin: 'xlm' }) }))
    expect(
      await createLinqClient({ ...config, fetchImpl: wrong.fetchImpl }).createOrder({
        ...usdcBase,
        amountStableCoin: 10,
      })
    ).toMatchObject({ ok: false, code: 'unexpected_order' })

    const none = server(() => ({ status: 201, body: goodOrder() }))
    expect(
      await createLinqClient({ ...config, fetchImpl: none.fetchImpl }).createOrder({
        ...usdcBase,
      })
    ).toMatchObject({ ok: false, code: 'rejected' })
    expect(none.calls).toHaveLength(0)
  })

  it('checks a USDC trustline, and treats an unreachable ledger as unknown', async () => {
    const yes = server(() => ({ status: 200, body: { valid: true, trustsUSDC: true } }))
    expect(
      await createLinqClient({ ...config, fetchImpl: yes.fetchImpl }).hasUsdcTrustline(REFUND)
    ).toEqual({ ok: true, value: { trusts: true } })

    const no = server(() => ({ status: 200, body: { valid: true, trustsUSDC: false } }))
    expect(
      await createLinqClient({ ...config, fetchImpl: no.fetchImpl }).hasUsdcTrustline(REFUND)
    ).toEqual({ ok: true, value: { trusts: false } })

    const down = server(() => ({ status: 503, body: {} }))
    expect(
      await createLinqClient({ ...config, fetchImpl: down.fetchImpl }).hasUsdcTrustline(REFUND)
    ).toEqual({ ok: true, value: { trusts: 'unknown' } })
  })

  it('refuses an order whose deposit address is not on Stellar, so funds are never sent astray', async () => {
    const { fetchImpl } = server(() => ({
      status: 201,
      body: goodOrder({ chain: 'sui', walletAddress: '0xabc123' }),
    }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder(orderInput)
    expect(result).toMatchObject({ ok: false, code: 'unexpected_order' })
  })

  it('refuses an order whose address is not a classic Stellar account', async () => {
    const { fetchImpl } = server(() => ({
      status: 201,
      body: goodOrder({ walletAddress: 'GNOTAREALADDRESS' }),
    }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder(orderInput)
    expect(result).toMatchObject({ ok: false, code: 'unexpected_order' })
  })

  it('refuses an order for a different asset than XLM', async () => {
    const { fetchImpl } = server(() => ({ status: 201, body: goodOrder({ coin: 'usdc' }) }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder(orderInput)
    expect(result).toMatchObject({ ok: false, code: 'unexpected_order' })
  })

  it('passes a provider rejection through as a message the user can act on', async () => {
    const { fetchImpl } = server(() => ({ status: 400, body: { message: 'invalid bank account' } }))
    const result = await createLinqClient({ ...config, fetchImpl }).createOrder(orderInput)
    expect(result).toEqual({ ok: false, code: 'rejected', message: 'invalid bank account' })
  })

  it('reports a timeout as unknown, never as a failure, because the order may exist', async () => {
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const result = await createLinqClient({ ...config, fetchImpl, timeoutMs: 20 }).createOrder(
      orderInput
    )
    expect(result).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('reads the indicative rate and refuses a zero one', async () => {
    const ok = server(() => ({ status: 200, body: { rate: 1655, currency: 'NGN' } }))
    expect(await createLinqClient({ ...config, fetchImpl: ok.fetchImpl }).getRate()).toEqual({
      ok: true,
      value: { ngnPerUsd: 1655 },
    })
    const zero = server(() => ({ status: 200, body: { rate: 0 } }))
    expect(
      await createLinqClient({ ...config, fetchImpl: zero.fetchImpl }).getRate()
    ).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('retries once when the provider throttles, and succeeds on the second try', async () => {
    let n = 0
    const { fetchImpl, calls } = server(() => {
      n += 1
      return n === 1
        ? { status: 429, body: { message: 'Rate limit exceeded' } }
        : { status: 200, body: { accountName: 'John Doe', bankName: 'UBA' } }
    })
    const result = await createLinqClient({ ...config, fetchImpl, retryDelayMs: 0 }).verifyBank({
      bankCode: '033',
      accountNumber: '1234567890',
    })
    expect(result).toMatchObject({ ok: true, value: { accountName: 'John Doe' } })
    expect(calls).toHaveLength(2)
  })

  it('says which call failed and what the provider answered, after one retry', async () => {
    const { fetchImpl, calls } = server(() => ({ status: 503, body: {} }))
    const result = await createLinqClient({ ...config, fetchImpl, retryDelayMs: 0 }).verifyBank({
      bankCode: '033',
      accountNumber: '1234567890',
    })
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect((result as { message: string }).message).toContain('(bank lookup, 503)')
    expect(calls).toHaveLength(2)
  })

  it('retries an order with the same idempotency key, so it cannot become two', async () => {
    let n = 0
    const { fetchImpl, calls } = server(() => {
      n += 1
      return n === 1 ? { status: 502, body: {} } : { status: 201, body: goodOrder() }
    })
    const result = await createLinqClient({ ...config, fetchImpl, retryDelayMs: 0 }).createOrder(
      orderInput
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    const keys = calls.map((c) => JSON.parse(c.init.body ?? '{}') as { idempotencyKey: string })
    expect(keys[0]?.idempotencyKey).toBe('key-1')
    expect(keys[1]?.idempotencyKey).toBe('key-1')
  })

  it('does not retry a refusal or a timeout', async () => {
    const refused = server(() => ({ status: 400, body: { message: 'invalid bank account' } }))
    await createLinqClient({
      ...config,
      fetchImpl: refused.fetchImpl,
      retryDelayMs: 0,
    }).createOrder(orderInput)
    expect(refused.calls).toHaveLength(1)

    let hung = 0
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) => {
      hung += 1
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const result = await createLinqClient({
      ...config,
      fetchImpl,
      timeoutMs: 20,
      retryDelayMs: 0,
    }).createOrder(orderInput)
    expect(result).toMatchObject({ ok: false, code: 'unknown' })
    expect(hung).toBe(1)
  })

  it('reads an order status', async () => {
    const { fetchImpl, calls } = server(() => ({
      status: 200,
      body: { id: 'ord-1', status: 'disbursed', amountStableCoin: 6, amountNGN: 2000 },
    }))
    const result = await createLinqClient({ ...config, fetchImpl }).getStatus('ord-1')
    expect(result).toMatchObject({ ok: true, value: { status: 'disbursed', amountNGN: 2000 } })
    expect(calls[0]?.url).toBe('https://linq.test/b2b/status?id=ord-1')
  })

  it('is not configured without a key', () => {
    expect(createLinqClient({ baseUrl: 'https://linq.test', apiKey: '' }).configured).toBe(false)
    expect(createLinqClient(config).configured).toBe(true)
  })
})

describe('verifyLinqSignature', () => {
  const secret = 'whsec_test'
  const body = JSON.stringify({ event: 'order.completed', orderId: 'ord-1' })
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  it('accepts the signature over the raw body', () => {
    expect(verifyLinqSignature(body, good, secret)).toBe(true)
  })

  it('rejects a changed body, a wrong secret, and a missing or short header', () => {
    expect(verifyLinqSignature(body + ' ', good, secret)).toBe(false)
    expect(verifyLinqSignature(body, good, 'whsec_other')).toBe(false)
    expect(verifyLinqSignature(body, null, secret)).toBe(false)
    expect(verifyLinqSignature(body, 'sha256=abc', secret)).toBe(false)
  })

  it('rejects everything when no secret is configured', () => {
    expect(verifyLinqSignature(body, good, '')).toBe(false)
  })
})
