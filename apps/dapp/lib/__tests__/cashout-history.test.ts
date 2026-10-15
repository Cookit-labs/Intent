import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { cashoutRecords, type CashoutOrder } from '../naira/history'
import { createNairaOrderRepo } from '../naira/orders'

const repo = {
  listPaidForEmail: vi.fn(),
}
const session = { current: { email: 'user@example.com' } as { email: string } | undefined }
const mainnet = { current: true }

vi.mock('../naira/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../naira/orders')>()
  return { ...actual, getNairaOrderRepo: async () => repo, orderNetwork: () => 'mainnet' }
})
vi.mock('../server/session', () => ({ readSessionFromRequest: () => session.current }))
vi.mock('../server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db')>()
  return { ...actual, databaseConfigured: () => true }
})
vi.mock('@intent/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@intent/config')>()
  return { ...actual, isMainnet: () => mainnet.current }
})

const order = (over: Partial<CashoutOrder> = {}): CashoutOrder => ({
  id: 'ord-1',
  status: 'paid',
  coin: 'usdc',
  amount: '2.0000000',
  amountNgn: '2706.02',
  bankName: 'OPay',
  accountName: 'EMMANUEL DANIEL OKPOHO',
  accountMask: '••••3682',
  paymentHash: 'ab'.repeat(32),
  createdAt: '2026-10-15T00:10:09.000Z',
  ...over,
})

describe('cashoutRecords', () => {
  it('turns a paid-out order into a History row of kind cash-out', () => {
    const [row] = cashoutRecords([order()], 'https://stellar.expert/explorer/public')
    expect(row).toMatchObject({
      kind: 'cashout',
      sentAmount: '2.0000000',
      sentAsset: 'USDC',
      receivedAmount: '2706.02',
      receivedAsset: 'NGN',
      txHash: 'ab'.repeat(32),
      settledAt: '2026-10-15T00:10:09.000Z',
      explorerUrl: `https://stellar.expert/explorer/public/tx/${'ab'.repeat(32)}`,
      payout: { statusLabel: 'Paid', bankName: 'OPay', accountMask: '••••3682' },
    })
  })

  it('labels the status in words, including a payout that failed', () => {
    const rows = cashoutRecords(
      [order({ status: 'processing' }), order({ status: 'failed', paymentHash: 'cd'.repeat(32) })],
      'x'
    )
    expect(rows.map((r) => r.payout?.statusLabel)).toEqual(['Paying out', 'Failed'])
  })

  it('shows only orders whose payment was sent', () => {
    expect(cashoutRecords([order({ paymentHash: undefined, status: 'expired' })], 'x')).toEqual([])
  })

  it('carries no account number or holder beyond the masked tail', () => {
    const text = JSON.stringify(cashoutRecords([order()], 'x'))
    expect(text).not.toMatch(/\d{10}/)
  })
})

describe('the repository list', () => {
  it('is scoped to the user and the network, and only to orders that were paid', async () => {
    const seen: { sql: string; params: unknown[] | undefined }[] = []
    const real = createNairaOrderRepo(async (sql, params) => {
      seen.push({ sql, params })
      return { rows: [] }
    })
    await real.listPaidForEmail('user@example.com', 'mainnet', 50)
    expect(seen[0]?.params).toEqual(['user@example.com', 'mainnet', 50])
    expect(seen[0]?.sql).toMatch(/email = \$1/)
    expect(seen[0]?.sql).toMatch(/network = \$2/)
    expect(seen[0]?.sql).toMatch(/payment_hash IS NOT NULL/)
  })
})

describe('GET /api/naira/orders', () => {
  // The route pulls in a large module graph; importing it once up front keeps
  // the first test from spending its own time budget on that under a full run.
  beforeAll(async () => {
    await import('../../app/api/naira/orders/route')
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    session.current = { email: 'user@example.com' }
    mainnet.current = true
    repo.listPaidForEmail.mockResolvedValue([])
  })

  async function list() {
    const { GET } = await import('../../app/api/naira/orders/route')
    return GET(new Request('http://localhost/api/naira/orders'))
  }

  it('answers 401 without a session', async () => {
    session.current = undefined
    expect((await list()).status).toBe(401)
    expect(repo.listPaidForEmail).not.toHaveBeenCalled()
  })

  it('answers an empty list on testnet, where there are no cash-outs', async () => {
    mainnet.current = false
    const res = await list()
    expect(await res.json()).toEqual({ orders: [] })
    expect(repo.listPaidForEmail).not.toHaveBeenCalled()
  })

  it('lists only the signed-in user’s paid orders, with no account number', async () => {
    repo.listPaidForEmail.mockResolvedValue([
      {
        id: 'ord-1',
        network: 'mainnet',
        email: 'user@example.com',
        account: 'GACCOUNT',
        providerOrder: 'prov-1',
        idempotencyKey: 'k',
        bankCode: '100004',
        bankName: 'OPay',
        accountNumber: '1234563682',
        accountName: 'EMMANUEL DANIEL OKPOHO',
        depositAddress: 'GDEPOSIT',
        coin: 'usdc',
        amount: '2.0000000',
        amountNgn: '2706.02',
        rate: '1353',
        status: 'paid',
        providerStatus: 'Settled in treasury',
        paymentHash: 'ab'.repeat(32),
        createdAt: '2026-10-15T00:10:09.000Z',
      },
    ])
    const res = await list()
    expect(repo.listPaidForEmail).toHaveBeenCalledWith('user@example.com', 'mainnet', 50)
    const body = (await res.json()) as { orders: Record<string, unknown>[] }
    expect(body.orders).toHaveLength(1)
    expect(body.orders[0]).toMatchObject({ accountMask: '••••3682', createdAt: expect.any(String) })
    expect(JSON.stringify(body)).not.toContain('1234563682')
  })

  it('answers an empty list rather than an error when the store cannot be read', async () => {
    repo.listPaidForEmail.mockRejectedValue(new Error('db down'))
    const res = await list()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orders: [] })
  })
})
