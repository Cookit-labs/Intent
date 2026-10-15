import { describe, expect, it } from 'vitest'

import { createMetricsRepo } from '../server/admin-metrics'

type Row = Record<string, unknown>

/** Answers each of the report's three statements by what it selects from. */
function fakeQuery(answers: { status: Row[]; coin: Row[]; attention: Row[]; cashed?: Row[] }) {
  const seen: { sql: string; params: unknown[] | undefined }[] = []
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
    seen.push({ sql, params })
    if (/GROUP BY status/.test(sql)) return { rows: answers.status }
    if (/GROUP BY coin/.test(sql)) return { rows: answers.coin }
    if (/FROM usage_executions/.test(sql)) return { rows: answers.cashed ?? [] }
    return { rows: answers.attention }
  }
  return { query, seen }
}

const scope = { network: 'mainnet' as const, range: '30d' as const }
const now = new Date('2026-10-14T12:00:00Z')

describe('metrics repo, naira payouts', () => {
  it('reports orders by status and asset, and the paid total', async () => {
    const { query } = fakeQuery({
      status: [
        { status: 'paid', n: '3', sent: '3', ngn: '15000.5' },
        { status: 'expired', n: '2', sent: '0', ngn: '4000' },
        { status: 'processing', n: '1', sent: '1', ngn: '2000' },
      ],
      coin: [
        { coin: 'xlm', orders: '4', paid: '2', paid_ngn: '9000' },
        { coin: 'usdc', orders: '2', paid: '1', paid_ngn: '6000.5' },
      ],
      attention: [],
    })
    const report = await createMetricsRepo(query).naira(scope, now)

    expect(report.orders).toBe(6)
    expect(report.paid).toEqual({ count: 3, ngn: 15000.5 })
    expect(report.byStatus.map((s) => s.status)).toEqual(['paid', 'expired', 'processing'])
    // An expired order with no payment sent is an abandoned one.
    expect(report.byStatus.find((s) => s.status === 'expired')).toMatchObject({
      count: 2,
      sent: 0,
    })
    expect(report.byCoin).toEqual([
      { coin: 'xlm', orders: 4, paid: 2, paidNgn: 9000 },
      { coin: 'usdc', orders: 2, paid: 1, paidNgn: 6000.5 },
    ])
  })

  it('lists payments that were sent and not paid out, without the account number', async () => {
    const { query, seen } = fakeQuery({
      status: [],
      coin: [],
      attention: [
        {
          id: 'ord-1',
          created_at: '2026-10-13T09:00:00Z',
          status: 'failed',
          coin: 'usdc',
          amount: '29.8731234',
          amount_ngn: '47797',
          bank_name: 'United Bank for Africa',
          tail: '7890',
          payment_hash: 'ab'.repeat(32),
        },
      ],
    })
    const report = await createMetricsRepo(query).naira(scope, now)

    expect(report.attention).toEqual([
      {
        id: 'ord-1',
        at: '2026-10-13T09:00:00.000Z',
        status: 'failed',
        coin: 'usdc',
        amount: '29.8731234',
        amountNgn: 47797,
        bankName: 'United Bank for Africa',
        accountTail: '7890',
        paymentHash: 'ab'.repeat(32),
      },
    ])

    // Only the last four digits ever leave the database, and holder names
    // are never selected.
    const sql = seen.map((s) => s.sql).join('\n')
    expect(sql).toContain('right(account_number, 4)')
    expect(sql).not.toMatch(/account_name/)
    expect(JSON.stringify(report)).not.toMatch(/1234567890/)
  })

  it('reports what was cashed out in dollars, and how many could not be priced', async () => {
    const { query, seen } = fakeQuery({
      status: [],
      coin: [],
      attention: [],
      cashed: [{ n: '3', usd: '7.5', unvalued: '1' }],
    })
    const report = await createMetricsRepo(query).naira(scope, now)
    expect(report.cashedOut).toEqual({ count: 3, usd: 7.5, unvalued: 1 })
    const sql = seen.find((s) => /FROM usage_executions/.test(s.sql))
    expect(sql?.sql).toMatch(/kind = 'offramp'/)
    expect(sql?.params?.[0]).toBe('mainnet')
  })

  it('scopes everything to the network, and the attention list to no date range', async () => {
    const { query, seen } = fakeQuery({ status: [], coin: [], attention: [] })
    await createMetricsRepo(query).naira(scope, now)

    expect(seen).toHaveLength(4)
    for (const call of seen) expect(call.params?.[0]).toBe('mainnet')

    const attention = seen.find((s) => /payment_hash IS NOT NULL AND status/.test(s.sql))
    expect(attention?.params).toEqual(['mainnet'])
    const counted = seen.filter((s) => s !== attention)
    for (const call of counted) expect(typeof call.params?.[1]).toBe('string')
  })

  it('reads an empty database as an empty report', async () => {
    const { query } = fakeQuery({ status: [], coin: [], attention: [] })
    expect(await createMetricsRepo(query).naira(scope, now)).toEqual({
      orders: 0,
      paid: { count: 0, ngn: 0 },
      cashedOut: { count: 0, usd: 0, unvalued: 0 },
      byStatus: [],
      byCoin: [],
      attention: [],
    })
  })
})
