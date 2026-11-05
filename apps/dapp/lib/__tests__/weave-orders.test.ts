import { describe, expect, it, vi } from 'vitest'

import type { WeaveOrder } from '../weave/client'
import {
  cleanMemo,
  createWeaveOrderRepo,
  depositExpectation,
  orderMismatch,
  payRefusal,
  readUsdcAmount,
  safeForReport,
  syncOrder,
  toPublic,
  WEAVE_DDL,
  type WeaveOrderRow,
} from '../weave/orders'

const ID = '3f7c1b2a-84e9-4c11-b3d2-0a9f7e123456'
const NOW = Date.parse('2026-11-04T12:00:00.000Z')

function row(over: Partial<WeaveOrderRow> = {}): WeaveOrderRow {
  return {
    id: ID,
    chain: 'near',
    email: 'user@example.com',
    account: 'alice.near',
    providerOrder: 'ord_1',
    idempotencyKey: 'key',
    currency: 'KES',
    institutionCode: 'MPESA',
    institutionName: 'M-Pesa',
    accountIdentifier: '254700001234',
    accountName: 'JANE ADEYEMI',
    depositAddress: 'weave.near',
    depositMemo: undefined,
    amount: '25.5',
    estimatedDest: '3200.5',
    expiresAt: '2026-11-04T13:00:00.000Z',
    status: 'waiting',
    providerStatus: 'awaiting_deposit',
    depositHash: undefined,
    sendStarted: false,
    createdAt: '2026-11-04T11:00:00.000Z',
    ...over,
  }
}

describe('toPublic', () => {
  it('masks the account identifier and never returns it whole', () => {
    const view = toPublic(row())
    expect(view.accountMask).toBe('••••1234')
    expect(JSON.stringify(view)).not.toContain('254700001234')
  })

  it('shows nothing of an identifier too short to mask', () => {
    expect(toPublic(row({ accountIdentifier: '1234' })).accountMask).toBe('••••')
  })

  it('leaves out who made the order and the provider ids', () => {
    const text = JSON.stringify(toPublic(row()))
    expect(text).not.toContain('user@example.com')
    expect(text).not.toContain('ord_1')
  })
})

describe('readUsdcAmount', () => {
  it('reads decimal text and tidies it', () => {
    expect(readUsdcAmount('25.50', 6)).toBe('25.5')
    expect(readUsdcAmount('007', 6)).toBe('7')
    expect(readUsdcAmount('1.000000000', 6)).toBe('1')
  })

  it('refuses more places than the chain has', () => {
    expect(readUsdcAmount('1.1234567', 6)).toBeUndefined()
    expect(readUsdcAmount('1.1234567', 7)).toBe('1.1234567')
  })

  it.each(['0', '0.00', '-1', '1e3', '', ' ', '.5', '1.', '0x10', 'NaN'])('refuses %j', (text) => {
    expect(readUsdcAmount(text, 6)).toBeUndefined()
  })
})

describe('orderMismatch', () => {
  const asked = { chain: 'near', currency: 'KES', amount: '25.5' } as const
  const near = {
    isDepositAddress: (a: string) => a.endsWith('.near'),
    supportsMemo: false,
    usdcDecimals: 6,
  }
  const answer: WeaveOrder = {
    id: 'ord_1',
    status: 'awaiting_deposit',
    sourceAssetKey: 'crypto:NEAR:USDC',
    destAssetKey: 'fiat:KES',
    deposit: {
      address: 'weave.near',
      memo: undefined,
      amount: '25.5',
      token: 'USDC',
      chain: 'NEAR',
    },
  }
  const withDeposit = (over: Partial<WeaveOrder['deposit']>): WeaveOrder => ({
    ...answer,
    deposit: { ...answer.deposit, ...over },
  })

  it('accepts an answer that matches', () => {
    expect(orderMismatch(answer, asked, near)).toBeUndefined()
  })

  it('compares chain and token without regard to case', () => {
    expect(
      orderMismatch(withDeposit({ chain: 'near', token: 'usdc' }), asked, near)
    ).toBeUndefined()
  })

  it('compares the amount as a number, not as text', () => {
    expect(orderMismatch(withDeposit({ amount: '25.50' }), asked, near)).toBeUndefined()
    expect(orderMismatch(withDeposit({ amount: '025.500000' }), asked, near)).toBeUndefined()
  })

  it('allows the fee Weave adds on top, as seen live: 5.05322 asked for on 5', () => {
    expect(
      orderMismatch(withDeposit({ amount: '5.05322' }), { ...asked, amount: '5' }, near)
    ).toBeUndefined()
    expect(orderMismatch(withDeposit({ amount: '26.01' }), asked, near)).toBeUndefined()
  })

  it.each([
    ['more than 2% over', '26.02'],
    ['less than was asked', '25.49'],
    ['far too much', '255'],
    ['more places than the token has', '25.5000001'],
    ['not a plain amount', '1e3'],
  ])('refuses a deposit of %s', (_name, amount) => {
    expect(orderMismatch(withDeposit({ amount }), asked, near)).toBe('amount')
  })

  it.each([
    ['chain', { chain: 'SOLANA' }],
    ['token', { token: 'USDT' }],
    ['address', { address: 'weave.sol' }],
    ['memo', { memo: 'M1' }],
  ])('names a wrong %s', (field, over) => {
    expect(orderMismatch(withDeposit(over), asked, near)).toBe(field)
  })

  it('allows a memo on a chain that can carry one', () => {
    expect(
      orderMismatch(withDeposit({ memo: 'M1' }), asked, { ...near, supportsMemo: true })
    ).toBeUndefined()
  })

  it('reads an empty memo as no memo on a chain that cannot carry one', () => {
    expect(orderMismatch(withDeposit({ memo: '' }), asked, near)).toBeUndefined()
  })

  it('names a wrong source or destination asset when the answer states them', () => {
    expect(orderMismatch({ ...answer, sourceAssetKey: 'crypto:NEAR:USDT' }, asked, near)).toBe(
      'source_asset'
    )
    expect(orderMismatch({ ...answer, destAssetKey: 'fiat:NGN' }, asked, near)).toBe('dest_asset')
  })

  it('does not need the asset keys', () => {
    const { sourceAssetKey: _source, destAssetKey: _dest, ...bare } = answer
    expect(orderMismatch(bare, asked, near)).toBeUndefined()
  })
})

describe('syncOrder', () => {
  const repo = () => ({ setStatus: vi.fn(async () => undefined) })

  it('records what Weave says and returns the moved row', async () => {
    const r = repo()
    const synced = await syncOrder(r, row(), {
      getOrder: async () => ({ ok: true, value: { id: 'ord_1', status: 'processing' } }),
    })
    expect(synced).toMatchObject({ reached: true, row: { status: 'processing' } })
    expect(r.setStatus).toHaveBeenCalledWith('ord_1', 'processing', 'processing')
  })

  it('writes nothing when nothing changed', async () => {
    const r = repo()
    await syncOrder(r, row(), {
      getOrder: async () => ({ ok: true, value: { id: 'ord_1', status: 'awaiting_deposit' } }),
    })
    expect(r.setStatus).not.toHaveBeenCalled()
  })

  it('says when Weave could not be asked, and keeps the row', async () => {
    const r = repo()
    const synced = await syncOrder(r, row(), {
      getOrder: async () => ({ ok: false, code: 'unavailable', message: 'x' }),
    })
    expect(synced.reached).toBe(false)
    expect(synced.row.status).toBe('waiting')
    expect(r.setStatus).not.toHaveBeenCalled()
  })

  it('does not ask about an order that has ended', async () => {
    const r = repo()
    const getOrder = vi.fn()
    const synced = await syncOrder(r, row({ status: 'paid', providerStatus: 'completed' }), {
      getOrder,
    })
    expect(getOrder).not.toHaveBeenCalled()
    expect(synced.reached).toBe(true)
  })
})

describe('payRefusal', () => {
  const reached = (over: Partial<WeaveOrderRow> = {}) => ({ row: row(over), reached: true })

  it('allows an order positively waiting, unpaid and in time', () => {
    expect(payRefusal(reached(), NOW)).toBeUndefined()
  })

  it('allows an order with no expiry', () => {
    expect(payRefusal(reached({ expiresAt: undefined }), NOW)).toBeUndefined()
  })

  it('refuses when Weave could not be asked', () => {
    expect(payRefusal({ row: row(), reached: false }, NOW)).toMatchObject({ status: 503 })
  })

  it('refuses a status it cannot read, even though the order stays waiting', () => {
    expect(payRefusal(reached({ providerStatus: 'settling' }), NOW)).toMatchObject({ status: 503 })
  })

  it.each(['processing', 'paid', 'failed', 'expired', 'refunded'] as const)(
    'refuses %s',
    (status) => {
      expect(payRefusal(reached({ status }), NOW)).toMatchObject({ status: 409 })
    }
  )

  it('refuses an order that already has its deposit', () => {
    expect(payRefusal(reached({ depositHash: 'abc' }), NOW)).toMatchObject({ status: 409 })
  })

  it('refuses an order past its expiry', () => {
    expect(payRefusal(reached({ expiresAt: '2026-11-04T11:59:59.000Z' }), NOW)).toMatchObject({
      status: 409,
    })
  })
})

describe('depositExpectation', () => {
  it('comes from the row alone', () => {
    expect(depositExpectation(row({ depositMemo: 'M1' }))).toEqual({
      account: 'alice.near',
      depositAddress: 'weave.near',
      memo: 'M1',
      amount: '25.5',
    })
  })

  it('never carries an empty memo, which chains would refuse', () => {
    expect(depositExpectation(row({ depositMemo: '' })).memo).toBeUndefined()
  })
})

describe('cleanMemo', () => {
  it('reads null and empty as no memo', () => {
    expect(cleanMemo(null)).toBeUndefined()
    expect(cleanMemo(undefined)).toBeUndefined()
    expect(cleanMemo('')).toBeUndefined()
    expect(cleanMemo('M1')).toBe('M1')
  })
})

describe('safeForReport', () => {
  it('strips the account digits, holder and memo from an error', () => {
    const r = row({ depositMemo: 'MEMO99' })
    const clean = safeForReport(
      new Error('send to 254700001234 JANE ADEYEMI memo MEMO99 failed'),
      r
    )
    expect(String(clean.message)).toBe('send to [redacted] [redacted] memo [redacted] failed')
    expect(String(clean.stack)).not.toMatch(/254700001234|JANE|MEMO99/)
  })
})

describe('createWeaveOrderRepo', () => {
  function fake(rows: Record<string, unknown>[] = []) {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }))
    return { query, repo: createWeaveOrderRepo(query) }
  }

  it('creates the table with the unique columns', async () => {
    const { query, repo } = fake()
    await repo.ensureSchema()
    expect(query).toHaveBeenCalledTimes(WEAVE_DDL.length)
    const ddl = WEAVE_DDL.join('\n')
    expect(ddl).toMatch(/provider_order\s+TEXT\s+NOT NULL UNIQUE/)
    expect(ddl).toMatch(/idempotency_key\s+TEXT\s+NOT NULL UNIQUE/)
    expect(ddl).toMatch(/deposit_hash\s+TEXT\s+UNIQUE/)
  })

  it('says a hash was stored only when this order now holds it', async () => {
    const { repo } = fake([{ id: ID }])
    expect(await repo.setDepositHash(ID, 'abc')).toBe('stored')
  })

  it('says reused when this order already holds a different hash', async () => {
    const { repo } = fake([])
    expect(await repo.setDepositHash(ID, 'abc')).toBe('reused')
  })

  it('says reused when another order holds the hash', async () => {
    const repo = createWeaveOrderRepo(async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    })
    expect(await repo.setDepositHash(ID, 'abc')).toBe('reused')
  })

  it('lets any other database failure through', async () => {
    const repo = createWeaveOrderRepo(async () => {
      throw new Error('down')
    })
    await expect(repo.setDepositHash(ID, 'abc')).rejects.toThrow('down')
  })

  it('reads an empty stored memo as no memo', async () => {
    const { repo } = fake([
      {
        id: ID,
        chain: 'near',
        deposit_memo: '',
        status: 'waiting',
        created_at: new Date('2026-11-04T11:00:00.000Z'),
      },
    ])
    expect((await repo.getForEmail(ID, 'a@b.c'))?.depositMemo).toBeUndefined()
  })

  it('stores an empty memo as null', async () => {
    const { query, repo } = fake()
    const { createdAt: _created, depositHash: _hash, ...fresh } = row({ depositMemo: '' })
    await repo.insert(fresh)
    expect(query.mock.calls[0]?.[1]?.[12]).toBeNull()
  })

  it('scopes reads by email', async () => {
    const { query, repo } = fake()
    await repo.getForEmail(ID, 'a@b.c')
    await repo.getByIdempotencyKey('k', 'a@b.c')
    await repo.listForEmail('a@b.c', 50)
    await repo.findHolder('a@b.c', 'KES', 'MPESA', '1')
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toMatch(/email = \$\d/)
      expect(params).toContain('a@b.c')
    }
  })

  it('does not send an id that is not a uuid to the database', async () => {
    const { query, repo } = fake()
    expect(await repo.getForEmail('not-a-uuid', 'a@b.c')).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('never overwrites a final status or goes back to waiting', async () => {
    const { query, repo } = fake()
    await repo.setStatus('ord_1', 'processing', 'processing')
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toMatch(/status NOT IN \('paid', 'failed', 'expired', 'refunded'\)/)
    expect(sql).toMatch(/NOT \(status <> 'waiting' AND \$2 = 'waiting'\)/)
  })

  it('keeps the first deposit hash', async () => {
    const { query, repo } = fake()
    await repo.setDepositHash(ID, 'abc')
    expect(String(query.mock.calls[0]?.[0])).toMatch(/deposit_hash IS NULL/)
  })

  it('reads a row with nothing optional set', async () => {
    const { repo } = fake([
      {
        id: ID,
        chain: 'near',
        email: 'a@b.c',
        account: 'alice.near',
        provider_order: 'ord_1',
        idempotency_key: 'k',
        currency: 'KES',
        institution_code: 'MPESA',
        institution_name: 'M-Pesa',
        account_identifier: '123456',
        account_name: 'JANE',
        deposit_address: 'weave.near',
        deposit_memo: null,
        amount: '25.5',
        estimated_dest: '3200.5',
        expires_at: null,
        status: 'waiting',
        provider_status: 'awaiting_deposit',
        deposit_hash: null,
        created_at: new Date('2026-11-04T11:00:00.000Z'),
      },
    ])
    const found = await repo.getForEmail(ID, 'a@b.c')
    expect(found).toMatchObject({
      depositMemo: undefined,
      expiresAt: undefined,
      depositHash: undefined,
      createdAt: '2026-11-04T11:00:00.000Z',
    })
  })
})
