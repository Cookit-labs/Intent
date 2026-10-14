import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = Keypair.random().publicKey()
const DEPOSIT = Keypair.random().publicKey()
const KEY = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'

const linq = {
  configured: true,
  verifyBank: vi.fn(),
  getRate: vi.fn(),
  hasUsdcTrustline: vi.fn(),
  createOrder: vi.fn(),
  getStatus: vi.fn(),
}
const repo = {
  ensureSchema: vi.fn(),
  insert: vi.fn(),
  getForEmail: vi.fn(),
  getByIdempotencyKey: vi.fn(),
  getByProviderOrder: vi.fn(),
  setStatus: vi.fn(),
  setPaymentHash: vi.fn(),
}
const balanceOf = vi.fn()

vi.mock('../linq/client', () => ({ createLinqClient: () => linq }))
vi.mock('../naira/guard', () => ({
  guardNaira: () => ({ ok: true, email: 'user@example.com' }),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../swap/delivered-balance', () => ({ balanceOf: (...a: unknown[]) => balanceOf(...a) }))
vi.mock('../naira/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../naira/orders')>()
  return { ...actual, getNairaOrderRepo: async () => repo, orderNetwork: () => 'mainnet' }
})

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/naira/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const usdcBody = {
  coin: 'usdc',
  account: ACCOUNT,
  bankCode: '033',
  accountNumber: '1234567890',
  amountUsdc: 29.87312349,
  idempotencyKey: KEY,
}

async function route(): Promise<typeof import('../../app/api/naira/orders/route')> {
  return import('../../app/api/naira/orders/route')
}

beforeEach(() => {
  vi.clearAllMocks()
  repo.getByIdempotencyKey.mockResolvedValue(undefined)
  balanceOf.mockResolvedValue(BigInt(300_000_000)) // 30 USDC
  linq.hasUsdcTrustline.mockResolvedValue({ ok: true, value: { trusts: true } })
  linq.getRate.mockResolvedValue({ ok: true, value: { ngnPerUsd: 1600 } })
  linq.verifyBank.mockResolvedValue({
    ok: true,
    value: { accountName: 'JOHN DOE', bankName: 'UBA' },
  })
  linq.createOrder.mockResolvedValue({
    ok: true,
    value: {
      id: 'prov-1',
      depositAddress: DEPOSIT,
      coin: 'usdc',
      amountCoin: 29.8731234,
      amountNGN: 47797,
      rate: 1600,
      status: 'initiated',
    },
  })
})

describe('POST /api/naira/orders, USDC', () => {
  it('orders the delivered USDC rounded down to seven places, and stores it', async () => {
    const { POST } = await route()
    const res = await POST(post(usdcBody))
    expect(res.status).toBe(200)

    expect(linq.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        coin: 'usdc',
        amountStableCoin: 29.8731234,
        accountName: 'JOHN DOE',
        refundAddress: ACCOUNT,
      })
    )
    expect(linq.createOrder.mock.calls[0]?.[0]).not.toHaveProperty('amountNGN')
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'usdc', amount: '29.8731234', network: 'mainnet' })
    )

    const body = (await res.json()) as { order: Record<string, unknown> }
    expect(body.order['accountMask']).toBe('••••7890')
    expect(JSON.stringify(body)).not.toContain('1234567890')
  })

  it('refuses more USDC than the account holds, before asking the provider', async () => {
    balanceOf.mockResolvedValue(BigInt(100_000_000)) // 10 USDC
    const { POST } = await route()
    const res = await POST(post(usdcBody))
    expect(res.status).toBe(409)
    expect(linq.createOrder).not.toHaveBeenCalled()
    expect(repo.insert).not.toHaveBeenCalled()
  })

  it('refuses an account that cannot receive a USDC refund', async () => {
    linq.hasUsdcTrustline.mockResolvedValue({ ok: true, value: { trusts: false } })
    const { POST } = await route()
    const res = await POST(post(usdcBody))
    expect(res.status).toBe(409)
    expect(linq.createOrder).not.toHaveBeenCalled()
  })

  it('carries on when the trustline check cannot be made', async () => {
    linq.hasUsdcTrustline.mockResolvedValue({ ok: true, value: { trusts: 'unknown' } })
    const { POST } = await route()
    expect((await POST(post(usdcBody))).status).toBe(200)
  })

  it('refuses a payout over the naira cap, estimated from the indicative rate', async () => {
    linq.getRate.mockResolvedValue({ ok: true, value: { ngnPerUsd: 100_000 } })
    const { POST } = await route()
    const res = await POST(post(usdcBody))
    expect(res.status).toBe(400)
    expect(linq.createOrder).not.toHaveBeenCalled()
  })

  it('returns the order already made when the same attempt is retried', async () => {
    const { toPublic } = await import('../naira/orders')
    repo.getByIdempotencyKey.mockResolvedValue({
      id: 'ord-1',
      network: 'mainnet',
      email: 'user@example.com',
      account: ACCOUNT,
      providerOrder: 'prov-1',
      idempotencyKey: KEY,
      bankCode: '033',
      bankName: 'United Bank for Africa',
      accountNumber: '1234567890',
      accountName: 'JOHN DOE',
      depositAddress: DEPOSIT,
      coin: 'usdc',
      amount: '29.8731234',
      amountNgn: '47797',
      rate: '1600',
      status: 'waiting',
      providerStatus: 'initiated',
      paymentHash: undefined,
      createdAt: new Date().toISOString(),
    })
    const { POST } = await route()
    const res = await POST(post(usdcBody))
    const body = (await res.json()) as { order: { id: string } }
    expect(body.order.id).toBe('ord-1')
    expect(linq.createOrder).not.toHaveBeenCalled()
    expect(toPublic).toBeTypeOf('function')
  })

  it('still orders XLM by the naira amount', async () => {
    linq.createOrder.mockResolvedValue({
      ok: true,
      value: {
        id: 'prov-2',
        depositAddress: DEPOSIT,
        coin: 'xlm',
        amountCoin: 6,
        amountNGN: 2000,
        rate: 333.33,
        status: 'initiated',
      },
    })
    const { POST } = await route()
    const res = await POST(
      post({
        coin: 'xlm',
        account: ACCOUNT,
        bankCode: '033',
        accountNumber: '1234567890',
        amountNgn: 2000,
        idempotencyKey: KEY,
      })
    )
    expect(res.status).toBe(200)
    expect(linq.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'xlm', amountNGN: 2000 })
    )
    expect(linq.createOrder.mock.calls[0]?.[0]).not.toHaveProperty('amountStableCoin')
    expect(balanceOf).not.toHaveBeenCalled()
  })
})
