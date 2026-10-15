import { describe, expect, it } from 'vitest'

import { CASHOUT_TURN_PREFIX, cashoutTurns, type CashoutOrder } from '../naira/history'

function order(over: Partial<CashoutOrder> = {}): CashoutOrder {
  return {
    id: 'o1',
    status: 'paid',
    coin: 'xlm',
    amount: '12',
    amountNgn: '3000',
    bankName: 'GTBank',
    accountName: 'A B',
    accountMask: '****1234',
    paymentHash: 'h1',
    createdAt: '2026-10-15T10:00:00.000Z',
    ...over,
  }
}

describe('cash-outs in past intents', () => {
  it('lists a sent payout as a row with its transaction', () => {
    const [row] = cashoutTurns([order()], 'stellar')
    expect(row).toMatchObject({
      id: `${CASHOUT_TURN_PREFIX}o1`,
      chain: 'stellar',
      txHash: 'h1',
      winner: null,
    })
    expect(row?.text).toContain('Cash out 12 XLM')
    expect(row?.outcome).toBe('Paid: 12 XLM cashed out as ₦3000 to A B, GTBank ****1234.')
  })

  it('leaves out orders never paid and payouts a chat already carries', () => {
    const rows = cashoutTurns(
      [order({ id: 'a', paymentHash: undefined }), order({ id: 'b', paymentHash: 'h2' })],
      'stellar',
      new Set(['h2'])
    )
    expect(rows).toEqual([])
  })
})
