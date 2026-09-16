import { describe, expect, it } from 'vitest'

import { fetchSwapHistory } from '../swap/history'

/**
 * Resting orders in history.
 *
 * A limit order placed through this app left no trace in its own history: the
 * ledger reader looked at path payments and contract calls, and an order is
 * neither. So a user could place one, watch it rest on the book, and find
 * nothing in the record of what they had done.
 *
 * An order is a different kind of thing from a swap — nothing has been
 * exchanged yet, and it may never fill — but it is an instruction the user
 * gave, and that belongs in their history.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'

/** Shaped like the live testnet record this was built against. */
function offerOp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'manage_buy_offer',
    transaction_hash: 'offer111',
    created_at: '2026-09-15T12:07:52Z',
    amount: '1336.0326986',
    price: '0.0559999',
    offer_id: '0',
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    ...over,
  }
}

function respond(records: unknown[]): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ _embedded: { records } }))
    )) as unknown as typeof fetch
}

describe('a resting order appears in history', () => {
  it('is named a limit order, not a swap', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp()]),
      onlyThisApp: false,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('limit')
  })

  it('reports what it offers and what it asks', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp()]),
      onlyThisApp: false,
    })

    expect(rows[0]?.sentAmount).toBe('1336.0326986')
    expect(rows[0]?.sentAsset).toBe('XLM')
    expect(rows[0]?.receivedAsset).toBe('USDC')
  })

  it('links to the transaction that placed it', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp()]),
      onlyThisApp: false,
    })

    expect(rows[0]?.explorerUrl).toContain('offer111')
  })

  it('reads a sell offer as well as a buy offer', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp({ type: 'manage_sell_offer' })]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('limit')
  })
})

describe('a cancellation is not a new order', () => {
  it('ignores a zero-amount offer', async () => {
    // Stellar has no delete operation: withdrawing an order is an offer of
    // zero. Listing it as a placement would invert its meaning, showing a user
    // an order they had just cancelled.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp({ amount: '0', transaction_hash: 'cancel222' })]),
      onlyThisApp: false,
    })

    expect(rows).toHaveLength(0)
  })

  it('keeps the placement but drops the cancellation', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([offerOp(), offerOp({ amount: '0', transaction_hash: 'cancel222' })]),
      onlyThisApp: false,
    })

    expect(rows.map((r) => r.txHash)).toEqual(['offer111'])
  })
})

describe('orders sit alongside the other kinds', () => {
  it('appears with swaps, newest first', async () => {
    const swap = {
      type: 'path_payment_strict_send',
      transaction_hash: 'swap999',
      created_at: '2026-09-14T00:00:00Z',
      from: ME,
      to: ME,
      source_amount: '20.0000000',
      source_asset_type: 'credit_alphanum4',
      source_asset_code: 'USDC',
      amount: '189.5359250',
      asset_type: 'native',
      path: [],
    }

    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swap, offerOp()]),
      onlyThisApp: false,
    })

    expect(rows.map((r) => r.kind)).toEqual(['limit', 'swap'])
  })
})
