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

/**
 * A Soroban router swap.
 *
 * Shaped like a real Horizon `invoke_host_function` record: the amounts live in
 * `asset_balance_changes` as a pair of transfers, because a contract call moves
 * value through token contracts rather than through a path payment. Reading
 * path payments alone made every Soroswap trade invisible, which is exactly the
 * route the agents pick whenever it quotes better.
 */
function routerOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'invoke_host_function',
    transaction_hash: 'bb11cc22dd33ee44ff5566778899aabbccddeeff00112233445566778899aabb',
    created_at: '2026-09-15T01:10:00Z',
    function: 'HostFunctionTypeHostFunctionTypeInvokeContract',
    asset_balance_changes: [
      {
        type: 'transfer',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        amount: '500.0000000',
        from: ME,
        to: 'CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA',
      },
      {
        type: 'transfer',
        asset_type: 'native',
        amount: '4737.0325000',
        from: 'CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA',
        to: ME,
      },
    ],
    ...overrides,
  }
}

describe('a router swap is a swap too', () => {
  it('reads one from the transfers a contract call performed', async () => {
    // The bug this covers: a $500 USDC to XLM trade through Soroswap settled
    // on-chain and history showed nothing at all.
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([routerOp()]) })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.sentAmount).toBe('500.0000000')
    expect(rows[0]?.sentAsset).toBe('USDC')
    expect(rows[0]?.receivedAmount).toBe('4737.0325000')
    expect(rows[0]?.receivedAsset).toBe('XLM')
  })

  it('links to the transaction', async () => {
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([routerOp()]) })
    expect(rows[0]?.explorerUrl).toContain('bb11cc22')
  })

  it('ignores a contract call that only moved value one way', async () => {
    // A supply to Blend sends and receives nothing back. Real activity, but
    // listing it as a swap would misdescribe it.
    const supply = routerOp({
      asset_balance_changes: [
        {
          type: 'transfer',
          asset_type: 'native',
          amount: '4737.0325000',
          from: ME,
          to: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
        },
      ],
    })
    expect(await fetchSwapHistory(ME, { fetchImpl: respond([supply]) })).toHaveLength(0)
  })

  it('ignores a contract call with no transfers at all', async () => {
    const bare = routerOp({ asset_balance_changes: [] })
    expect(await fetchSwapHistory(ME, { fetchImpl: respond([bare]) })).toHaveLength(0)
  })

  it('ignores transfers between two other parties', async () => {
    // Someone else's swap routed through the same pool is not this account's
    // trade, whichever contract it touched.
    const theirs = routerOp({
      asset_balance_changes: [
        { type: 'transfer', asset_type: 'native', amount: '1.0', from: OTHER, to: 'CPOOL' },
        { type: 'transfer', asset_type: 'native', amount: '1.0', from: 'CPOOL', to: OTHER },
      ],
    })
    expect(await fetchSwapHistory(ME, { fetchImpl: respond([theirs]) })).toHaveLength(0)
  })

  it('lists classic and router swaps together, newest first', async () => {
    // Both shapes are swaps and belong in one list. Ordering by settlement
    // keeps the record readable rather than grouped by how it was routed.
    const older = swapOp({ created_at: '2026-09-14T00:00:00Z', transaction_hash: 'old111' })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([older, routerOp()]),
      onlyThisApp: false,
    })

    expect(rows).toHaveLength(2)
    expect(rows[0]?.txHash).toContain('bb11cc22')
    expect(rows[1]?.txHash).toBe('old111')
  })

  it('still shows a router swap despite carrying no memo', async () => {
    // A Soroban transaction has no text memo, so the stamp that marks this
    // app's classic trades cannot exist. Filtering strictly on it would hide
    // every router trade the app ever made.
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([routerOp()]) })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.fromThisApp).toBe(false)
  })
})

describe('a router swap is never filtered out by a memo it cannot carry', () => {
  /** Operations first, then the memo lookup — the order the reader calls them. */
  function respondPair(ops: unknown[], txs: unknown[]): typeof fetch {
    let call = 0
    return (() => {
      call += 1
      const body = call === 1 ? { _embedded: { records: ops } } : { _embedded: { records: txs } }
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as unknown as typeof fetch
  }

  const STAMP = {
    hash: '1ec2b80f110f86e98493ac3b04b656e91238c37c36ce476e9ab99ab87ed8484c',
    memo: 'intent:swap:v1',
    memo_type: 'text',
  }

  it('survives alongside a stamped classic swap', () => {
    // The regression. A Soroban transaction cannot carry a text memo, and the
    // unstamped fallback only fires when *zero* swaps are stamped — so any
    // account with one classic trade silently discarded every router trade.
    return fetchSwapHistory(ME, {
      fetchImpl: respondPair([swapOp(), routerOp()], [STAMP]),
    }).then((rows) => {
      expect(rows.map((r) => r.txHash)).toContain(routerOp().transaction_hash)
    })
  })

  it('keeps the stamped classic swap too', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respondPair([swapOp(), routerOp()], [STAMP]),
    })
    expect(rows).toHaveLength(2)
  })

  it('still hides a stamped-era classic swap from another wallet', async () => {
    // Widening for router swaps must not have widened for classic ones: an
    // unstamped path payment alongside a stamped one is still someone else's.
    const foreign = swapOp({ transaction_hash: 'foreign', created_at: '2026-09-08T00:00:00Z' })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respondPair([swapOp(), foreign], [STAMP]),
    })
    expect(rows.map((r) => r.txHash)).not.toContain('foreign')
  })

  it('orders the merged list newest first', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respondPair([swapOp(), routerOp()], [STAMP]),
    })
    expect(rows[0]?.txHash).toBe(routerOp().transaction_hash)
  })
})

describe('a row is named for what it actually was', () => {
  /** Operations first, then the memo lookup — the order the reader calls them. */
  function withMemo(ops: unknown[], memo: string): typeof fetch {
    let call = 0
    return (() => {
      call += 1
      const body =
        call === 1
          ? { _embedded: { records: ops } }
          : {
              _embedded: {
                records: [{ hash: swapOp().transaction_hash, memo, memo_type: 'text' }],
              },
            }
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as unknown as typeof fetch
  }

  it('calls a resting order a limit order, not a swap', async () => {
    // Half the reported bug. The memo already distinguished these; the reader
    // collapsed every kind into one boolean and threw the distinction away, so
    // a limit order appeared in history labelled "Swap".
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'intent:limit:v1') })
    expect(rows[0]?.kind).toBe('limit')
  })

  it('calls a plan a bundle', async () => {
    // Several operations under one signature is a bundle to whoever signed it.
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'intent:plan:v1') })
    expect(rows[0]?.kind).toBe('bundle')
  })

  it('calls a pool operation liquidity', async () => {
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'intent:pool:v1') })
    expect(rows[0]?.kind).toBe('pool')
  })

  it('calls an ordinary stamped trade a swap', async () => {
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'intent:swap:v1') })
    expect(rows[0]?.kind).toBe('swap')
  })

  it('falls back to swap for an unstamped path payment', async () => {
    // A path payment between one account's own assets is a swap whoever built
    // it, so that is the honest default rather than a guess.
    const rows = await fetchSwapHistory(ME, { fetchImpl: respond([swapOp()]) })
    expect(rows[0]?.kind).toBe('swap')
  })

  it('falls back to swap for a memo it does not recognise', async () => {
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'something:else') })
    expect(rows[0]?.kind).toBe('swap')
  })

  it('counts every app memo as this app’s work, not just the swap one', async () => {
    // Before, only the swap memo marked a trade as ours, so a limit order this
    // app placed was treated as a stranger’s and filtered out.
    const rows = await fetchSwapHistory(ME, { fetchImpl: withMemo([swapOp()], 'intent:limit:v1') })
    expect(rows[0]?.fromThisApp).toBe(true)
  })
})
