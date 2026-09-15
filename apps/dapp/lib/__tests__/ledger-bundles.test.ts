import { describe, expect, it } from 'vitest'

import { fetchSwapHistory } from '../swap/history'

/**
 * Recognising a bundled intent from the ledger alone.
 *
 * A swap followed moments later by a supply of what it delivered is one
 * instruction, but the chain does not record it that way: a Soroban call
 * carries no memo, and the two transactions are unrelated on-chain. The app's
 * own record says they belong together — and that record is exactly what a
 * cleared browser loses.
 *
 * So the pairing is inferred, from three things together: the same asset, a
 * supply shortly after, and an amount within a fee of what the swap delivered.
 * Any one alone would pair coincidences. All three are what a real sequence
 * looks like, verified against a live account where it identified exactly the
 * two bundles that were made and left the other twelve swaps alone.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const BLEND = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'

/** A router swap: value leaves and comes back in the same transaction. */
function swapOp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'invoke_host_function',
    transaction_hash: 'swap111',
    created_at: '2026-09-15T00:39:00Z',
    asset_balance_changes: [
      {
        type: 'transfer',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        amount: '600.0000000',
        from: ME,
        to: 'CROUTER',
      },
      { type: 'transfer', asset_type: 'native', amount: '5662.4245219', from: 'CROUTER', to: ME },
    ],
    ...over,
  }
}

/** A supply: value leaves for a contract and nothing comes back. */
function supplyOp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'invoke_host_function',
    transaction_hash: 'supply222',
    created_at: '2026-09-15T00:39:20Z',
    asset_balance_changes: [
      { type: 'transfer', asset_type: 'native', amount: '5662.4212352', from: ME, to: BLEND },
    ],
    ...over,
  }
}

function respond(records: unknown[]): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ _embedded: { records } }))
    )) as unknown as typeof fetch
}

describe('a swap followed by a supply is one bundled intent', () => {
  it('names it a bundle rather than a swap', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), supplyOp()]),
      onlyThisApp: false,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('bundle')
  })

  it('carries both transactions', async () => {
    // The whole point of the label: a bundle is several transactions, and a
    // row claiming to be one must be able to show them.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), supplyOp()]),
      onlyThisApp: false,
    })

    const steps = rows[0]?.bundledWith ?? []
    expect(steps).toHaveLength(2)
    expect(steps[0]?.hash).toBe('swap111')
    expect(steps[1]?.hash).toBe('supply222')
  })

  it('links to the position, not only to the receipt', async () => {
    // An explorer proves the supply reached a ledger and says nothing about
    // the balance it created or the rate it earns.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), supplyOp()]),
      onlyThisApp: false,
    })

    const supply = (rows[0]?.bundledWith ?? [])[1]
    expect(supply?.positionUrl).toContain('blend.capital')
    expect(supply?.venue).toBe('Blend')
  })

  it('does not list the supply as a swap of its own', async () => {
    // A supply sends and receives nothing back. Listing it beside the bundle
    // would show the same instruction twice.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), supplyOp()]),
      onlyThisApp: false,
    })

    expect(rows.map((r) => r.txHash)).not.toContain('supply222')
  })
})

describe('a coincidence is not a bundle', () => {
  it('leaves a swap alone when no supply followed it', async () => {
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp()]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
    expect(rows[0]?.bundledWith).toBeUndefined()
  })

  it('refuses a supply of a different asset', async () => {
    // Supplying USDC after a swap that delivered XLM is a separate decision.
    const other = supplyOp({
      asset_balance_changes: [
        {
          type: 'transfer',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          amount: '5662.4212352',
          from: ME,
          to: BLEND,
        },
      ],
    })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), other]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
  })

  it('refuses a supply that arrived hours later', async () => {
    // A sequence signs its second step as soon as the first confirms. An hour
    // later is a decision the user made separately.
    const late = supplyOp({ created_at: '2026-09-15T04:39:00Z' })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), late]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
  })

  it('refuses a supply that arrived before the swap', async () => {
    // Order is meaning: proceeds cannot be supplied before they exist.
    const early = supplyOp({ created_at: '2026-09-15T00:38:00Z' })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), early]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
  })

  it('refuses an amount that is not what the swap delivered', async () => {
    // Half of it is a different instruction, however close in time.
    const half = supplyOp({
      asset_balance_changes: [
        { type: 'transfer', asset_type: 'native', amount: '2831.0000000', from: ME, to: BLEND },
      ],
    })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), half]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
  })

  it('allows the fee to make the supply slightly smaller', async () => {
    // The real case. Fees mean the supplied amount is always a shade under
    // what the swap delivered; requiring an exact match would pair nothing.
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), supplyOp()]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('bundle')
  })

  it('ignores a transfer to a contract the app does not integrate', async () => {
    // A one-way transfer somewhere unknown could be anything, and naming it
    // would be a guess dressed as a fact.
    const elsewhere = supplyOp({
      asset_balance_changes: [
        {
          type: 'transfer',
          asset_type: 'native',
          amount: '5662.4212352',
          from: ME,
          to: 'CUNKNOWN',
        },
      ],
    })
    const rows = await fetchSwapHistory(ME, {
      fetchImpl: respond([swapOp(), elsewhere]),
      onlyThisApp: false,
    })

    expect(rows[0]?.kind).toBe('swap')
  })
})
