import { createHmac } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const repo = {
  ensureSchema: vi.fn(),
  insert: vi.fn(),
  getForEmail: vi.fn(),
  getByIdempotencyKey: vi.fn(),
  findHolder: vi.fn(),
  getByProviderOrder: vi.fn(),
  setStatus: vi.fn(),
  setPaymentHash: vi.fn(),
}
const linq = { configured: true, getStatus: vi.fn() }
const buildNairaPayment = vi.fn()

vi.mock('../naira/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../naira/orders')>()
  return { ...actual, getNairaOrderRepo: async () => repo }
})
vi.mock('../linq/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../linq/client')>()
  return { ...actual, createLinqClient: () => linq }
})
vi.mock('../naira/guard', () => ({
  guardNaira: () => ({ ok: true, email: 'user@example.com' }),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../naira/build-payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../naira/build-payment')>()
  return { ...actual, buildNairaPayment: (...a: unknown[]) => buildNairaPayment(...a) }
})

import { reconcileBeforePay } from '../naira/reconcile'

const WATCHING = 'processing: wallet worker on it..'
const IN_QUEUE = 'processing: in bank queue'

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord-1',
    network: 'mainnet',
    email: 'user@example.com',
    account: 'GACCOUNT',
    providerOrder: 'prov-1',
    idempotencyKey: 'key-1',
    bankCode: '033',
    bankName: 'United Bank for Africa',
    accountNumber: '1234567890',
    accountName: 'JOHN DOE',
    depositAddress: 'GDEPOSIT',
    coin: 'usdc',
    amount: '2.0013411',
    amountNgn: '2709.88',
    rate: '1354',
    status: 'waiting',
    providerStatus: 'initiated',
    paymentHash: undefined,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function live(status: string) {
  return { ok: true, value: { id: 'prov-1', status, amountCoin: 2, amountNGN: 2709 } }
}

beforeEach(() => {
  vi.clearAllMocks()
  buildNairaPayment.mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'p' })
})

describe('reconcileBeforePay', () => {
  it('moves a stored "processing" back to waiting when the provider is still watching', async () => {
    linq.getStatus.mockResolvedValue(live(WATCHING))
    const out = await reconcileBeforePay(repo, row({ status: 'processing' }) as never, linq)
    expect(out.status).toBe('waiting')
    expect(repo.setStatus).toHaveBeenCalledWith('prov-1', 'waiting', WATCHING)
  })

  it('reports an order that already has its deposit as processing', async () => {
    linq.getStatus.mockResolvedValue(live(IN_QUEUE))
    const out = await reconcileBeforePay(repo, row() as never, linq)
    expect(out.status).toBe('processing')
  })

  it('never writes amounts back, so a waiting order keeps what it was made for', async () => {
    linq.getStatus.mockResolvedValue(live(WATCHING))
    await reconcileBeforePay(repo, row({ status: 'processing' }) as never, linq)
    expect(repo.setStatus.mock.calls[0]).toHaveLength(3)
  })

  it('leaves an order this app already paid alone, without asking', async () => {
    const paid = row({ paymentHash: 'ab'.repeat(32), status: 'processing' })
    const out = await reconcileBeforePay(repo, paid as never, linq)
    expect(out).toBe(paid)
    expect(linq.getStatus).not.toHaveBeenCalled()
  })

  it('keeps the stored row when the provider cannot be reached', async () => {
    linq.getStatus.mockResolvedValue({ ok: false, code: 'unavailable', message: 'x' })
    const stored = row({ status: 'processing' })
    const out = await reconcileBeforePay(repo, stored as never, linq)
    expect(out.status).toBe('processing')
    expect(repo.setStatus).not.toHaveBeenCalled()
  })
})

describe('POST /api/naira/orders/[id]/build', () => {
  async function build() {
    const { POST } = await import('../../app/api/naira/orders/[id]/build/route')
    return POST(new Request('http://localhost/x', { method: 'POST' }), { params: { id: 'ord-1' } })
  }

  it('builds the payment for an order the webhook had wrongly moved to processing', async () => {
    repo.getForEmail.mockResolvedValue(row({ status: 'processing', providerStatus: WATCHING }))
    linq.getStatus.mockResolvedValue(live(WATCHING))
    const res = await build()
    expect(res.status).toBe(200)
    expect(buildNairaPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        expectation: { destination: 'GDEPOSIT', coin: 'usdc', amount: '2.0013411' },
      })
    )
  })

  it('refuses an order that has had its deposit, and names the provider state', async () => {
    repo.getForEmail.mockResolvedValue(row())
    linq.getStatus.mockResolvedValue(live(IN_QUEUE))
    const res = await build()
    expect(res.status).toBe(409)
    const body = (await res.json()) as { providerStatus: string; message: string }
    expect(body.providerStatus).toBe(IN_QUEUE)
    expect(body.message).toContain(IN_QUEUE)
    expect(buildNairaPayment).not.toHaveBeenCalled()
  })

  it('refuses an expired order', async () => {
    repo.getForEmail.mockResolvedValue(row({ status: 'expired' }))
    linq.getStatus.mockResolvedValue(live('timeout: no deposit received'))
    expect((await build()).status).toBe(409)
    expect(buildNairaPayment).not.toHaveBeenCalled()
  })

  it('builds on a stored waiting order when the provider cannot be asked', async () => {
    repo.getForEmail.mockResolvedValue(row({ status: 'waiting' }))
    linq.getStatus.mockResolvedValue({ ok: false, code: 'unavailable', message: 'x' })
    expect((await build()).status).toBe(200)
  })

  it('does not build on a stored processing order when the provider cannot be asked', async () => {
    repo.getForEmail.mockResolvedValue(row({ status: 'processing' }))
    linq.getStatus.mockResolvedValue({ ok: false, code: 'unavailable', message: 'x' })
    expect((await build()).status).toBe(409)
  })
})

describe('POST /api/naira/webhook', () => {
  const SECRET = 'whsec_test_secret'

  async function send(payload: Record<string, unknown>, signature?: string) {
    vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET)
    const raw = JSON.stringify(payload)
    const sig = signature ?? 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex')
    const { POST } = await import('../../app/api/naira/webhook/route')
    return POST(
      new Request('http://localhost/api/naira/webhook', {
        method: 'POST',
        headers: { 'x-linq-signature': sig },
        body: raw,
      })
    )
  }

  it('reads a processing event that carries the watching text as still waiting', async () => {
    const res = await send({ event: 'order.processing', orderId: 'prov-1', status: WATCHING })
    expect(res.status).toBe(200)
    expect(repo.setStatus).toHaveBeenCalledWith('prov-1', 'waiting', WATCHING, undefined)
  })

  it('reads a processing event for a deposited order as processing, with its figures', async () => {
    await send({
      event: 'order.processing',
      orderId: 'prov-1',
      status: IN_QUEUE,
      amountStableCoin: 2.0013411,
      amountNGN: 2709.88,
    })
    expect(repo.setStatus).toHaveBeenCalledWith('prov-1', 'processing', IN_QUEUE, {
      amountCoin: 2.0013411,
      amountNgn: 2709.88,
    })
  })

  it('reads a completed event as paid', async () => {
    await send({ event: 'order.completed', orderId: 'prov-1', status: 'Settled in treasury' })
    expect(repo.setStatus).toHaveBeenCalledWith(
      'prov-1',
      'paid',
      'Settled in treasury',
      expect.anything()
    )
  })

  it('falls back to the event name only when there is no status text', async () => {
    await send({ event: 'order.processing', orderId: 'prov-1' })
    expect(repo.setStatus).toHaveBeenCalledWith('prov-1', 'processing', 'order.processing', {
      amountCoin: 0,
      amountNgn: 0,
    })
  })

  it('refuses a body that was not signed with the secret', async () => {
    const res = await send({ event: 'order.completed', orderId: 'prov-1' }, 'sha256=00')
    expect(res.status).toBe(401)
    expect(repo.setStatus).not.toHaveBeenCalled()
  })
})
