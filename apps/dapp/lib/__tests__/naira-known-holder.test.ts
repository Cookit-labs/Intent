import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createNairaOrderRepo } from '../naira/orders'

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
  findHolder: vi.fn(),
  getByProviderOrder: vi.fn(),
  setStatus: vi.fn(),
  setPaymentHash: vi.fn(),
}

vi.mock('../linq/client', () => ({ createLinqClient: () => linq }))
vi.mock('../naira/guard', () => ({
  guardNaira: () => ({ ok: true, email: 'user@example.com' }),
}))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../swap/delivered-balance', () => ({ balanceOf: async () => undefined }))
vi.mock('../naira/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../naira/orders')>()
  return { ...actual, getNairaOrderRepo: async () => repo, orderNetwork: () => 'mainnet' }
})

function post(url: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const lookup = { bankCode: '100004', accountNumber: '1234567890' }
const orderBody = {
  coin: 'xlm',
  account: ACCOUNT,
  amountNgn: 2000,
  idempotencyKey: KEY,
  ...lookup,
}

beforeEach(() => {
  vi.clearAllMocks()
  repo.getByIdempotencyKey.mockResolvedValue(undefined)
  repo.findHolder.mockResolvedValue(undefined)
  linq.getRate.mockResolvedValue({ ok: true, value: { ngnPerUsd: 1354 } })
  linq.createOrder.mockResolvedValue({
    ok: true,
    value: {
      id: 'prov-1',
      depositAddress: DEPOSIT,
      coin: 'xlm',
      amountCoin: 6,
      amountNGN: 2000,
      rate: 333,
      status: 'initiated',
    },
  })
})

describe('POST /api/naira/verify', () => {
  async function verify(body: Record<string, unknown> = lookup) {
    const { POST } = await import('../../app/api/naira/verify/route')
    return POST(post('/api/naira/verify', body))
  }

  it('answers from an earlier order to the same account, without asking the provider', async () => {
    repo.findHolder.mockResolvedValue('EMMANUEL DANIEL OKPOHO')
    const res = await verify()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { accountName: string }).accountName).toBe(
      'EMMANUEL DANIEL OKPOHO'
    )
    expect(linq.verifyBank).not.toHaveBeenCalled()
    expect(repo.findHolder).toHaveBeenCalledWith('user@example.com', '100004', '1234567890')
  })

  it('asks the provider for an account it has not seen', async () => {
    linq.verifyBank.mockResolvedValue({
      ok: true,
      value: { accountName: 'NEW PERSON', bankName: '' },
    })
    const res = await verify()
    expect(((await res.json()) as { accountName: string }).accountName).toBe('NEW PERSON')
    expect(linq.verifyBank).toHaveBeenCalledTimes(1)
  })

  it('still asks the provider when the record cannot be read', async () => {
    repo.findHolder.mockRejectedValue(new Error('db down'))
    linq.verifyBank.mockResolvedValue({
      ok: true,
      value: { accountName: 'NEW PERSON', bankName: '' },
    })
    expect((await verify()).status).toBe(200)
    expect(linq.verifyBank).toHaveBeenCalledTimes(1)
  })

  it('names the call when the provider is throttling and nothing is on record', async () => {
    linq.verifyBank.mockResolvedValue({
      ok: false,
      code: 'unavailable',
      message: 'Naira payouts are busy (bank lookup, 429). Try again in a moment.',
    })
    const res = await verify()
    expect(res.status).toBe(503)
    expect(((await res.json()) as { message: string }).message).toContain('(bank lookup, 429)')
  })
})

describe('POST /api/naira/orders', () => {
  async function order() {
    const { POST } = await import('../../app/api/naira/orders/route')
    return POST(post('/api/naira/orders', orderBody))
  }

  it('makes the order with the holder on record and spends no lookup', async () => {
    repo.findHolder.mockResolvedValue('EMMANUEL DANIEL OKPOHO')
    const res = await order()
    expect(res.status).toBe(200)
    expect(linq.verifyBank).not.toHaveBeenCalled()
    expect(linq.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountName: 'EMMANUEL DANIEL OKPOHO' })
    )
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ accountName: 'EMMANUEL DANIEL OKPOHO' })
    )
  })

  it('looks the holder up when this account has not been paid out to', async () => {
    linq.verifyBank.mockResolvedValue({
      ok: true,
      value: { accountName: 'NEW PERSON', bankName: '' },
    })
    const res = await order()
    expect(res.status).toBe(200)
    expect(linq.verifyBank).toHaveBeenCalledTimes(1)
    expect(linq.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountName: 'NEW PERSON' })
    )
  })

  it('takes no name from the browser, even when one is sent', async () => {
    repo.findHolder.mockResolvedValue('REAL HOLDER')
    const { POST } = await import('../../app/api/naira/orders/route')
    await POST(post('/api/naira/orders', { ...orderBody, accountName: 'SOMEONE ELSE' }))
    expect(linq.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountName: 'REAL HOLDER' })
    )
  })
})

describe('the holder lookup in the repository', () => {
  it('is scoped to the user and the account, and limited to the last thirty days', async () => {
    const seen: { sql: string; params: unknown[] | undefined }[] = []
    const real = createNairaOrderRepo(async (sql, params) => {
      seen.push({ sql, params })
      return { rows: [{ account_name: 'EMMANUEL DANIEL OKPOHO' }] }
    })
    expect(await real.findHolder('user@example.com', '100004', '1234567890')).toBe(
      'EMMANUEL DANIEL OKPOHO'
    )
    expect(seen[0]?.params).toEqual(['user@example.com', '100004', '1234567890'])
    expect(seen[0]?.sql).toMatch(/email = \$1/)
    expect(seen[0]?.sql).toMatch(/interval '30 days'/)
  })

  it('answers nothing when there is no earlier order', async () => {
    const real = createNairaOrderRepo(async () => ({ rows: [] }))
    expect(await real.findHolder('user@example.com', '100004', '1234567890')).toBeUndefined()
  })
})
