import { describe, expect, it } from 'vitest'

import { fetchSwapHistory } from '../swap/history'

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function respond(records: unknown[], status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ _embedded: { records } }), { status })
    )) as unknown as typeof fetch
}

/** Shaped like a real Horizon path_payment_strict_send record. */
function swapOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'path_payment_strict_send',
    transaction_hash: '1ec2b80f110f86e98493ac3b04b656e91238c37c36ce476e9ab99ab87ed8484c',
    created_at: '2026-09-09T12:53:07Z',
    from: ME,
    to: ME,
    source_amount: '158.3598146',
    source_asset_type: 'native',
    amount: '270.6431826',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    path: [],
    ...overrides,
  }
}

describe('fetchSwapHistory', () => {
  it('reads a swap from the ledger', async () => {
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([swapOp()]) })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sentAmount).toBe('158.3598146')
    expect(rows[0]?.sentAsset).toBe('XLM')
    expect(rows[0]?.receivedAsset).toBe('USDC')
    expect(rows[0]?.explorerUrl).toContain('1ec2b80f')
  })

  it('excludes a payment to somebody else', async () => {
    // Paying a third party is a transfer, not a swap, and belongs elsewhere.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp({ to: OTHER })]),
    })
    expect(rows).toHaveLength(0)
  })

  it('ignores operations that are not path payments', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([
        { type: 'change_trust', transaction_hash: 'x', created_at: '2026-01-01T00:00:00Z' },
        { type: 'create_account', transaction_hash: 'y', created_at: '2026-01-01T00:00:00Z' },
      ]),
    })
    expect(rows).toHaveLength(0)
  })

  it('counts intermediate hops', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([
        swapOp({ path: [{ asset_type: 'credit_alphanum4', asset_code: 'AQUA' }] }),
      ]),
    })
    expect(rows[0]?.hops).toBe(1)
  })

  it('treats an unreachable Horizon as empty, not broken', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    expect(rows).toEqual([])
  })

  it('treats a never-funded account as empty', async () => {
    // Horizon 404s for an account that does not exist yet.
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([], 404) })
    expect(rows).toEqual([])
  })
})
