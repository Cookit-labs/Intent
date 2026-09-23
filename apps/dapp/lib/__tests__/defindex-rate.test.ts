import { describe, expect, it } from 'vitest'

import { createContractsRegistry } from '../lend/defindex/contracts'
import { readDefindexRate, readDefindexVaultFor } from '../lend/defindex/rate'

/**
 * The one figure the agents are told about DeFindex: what its vault pays.
 *
 * Absent — not zero, not an error — whenever the figure would be wrong to
 * offer: no vault for the asset, a vault holding a different asset from the
 * one a swap delivers, or a vault the API reports no APY for. An agent
 * given no rate simply will not propose the venue, which is the safe reading
 * of every one of those.
 */

const XLM_VAULT = 'CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6'
const USDC_VAULT = 'CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
/** What DeFindex's testnet USDC vault holds: not the Circle USDC this app trades. */
const VAULT_USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

function registryWith(ids: Record<string, string>) {
  return createContractsRegistry({
    fetchImpl: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ids, hashes: {} }), { status: 200 })
      )) as unknown as typeof fetch,
  })
}

/** An API answering every vault read with `info`. */
function apiAnswering(info: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(info), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )) as unknown as typeof fetch
}

const BOTH = { xlm_paltalabs_vault: XLM_VAULT, usdc_paltalabs_vault: USDC_VAULT }

describe('reading what DeFindex pays for an asset', () => {
  it('returns the vault and its 7-day APY when the vault holds the asset', async () => {
    const rate = await readDefindexRate('XLM', {
      apiKey: 'sk',
      registry: registryWith(BOTH),
      fetchImpl: apiAnswering({ apy: 19.4, assets: [{ address: XLM_SAC, symbol: 'XLM' }] }),
    })

    expect(rate).toEqual({ vault: XLM_VAULT, apy: 19.4 })
  })

  it('offers nothing for a vault holding a different asset than this app trades', async () => {
    // The USDC case, measured 2026-09-23. A rate for a vault the swap cannot
    // fund is a rate for a step that would fail.
    const rate = await readDefindexRate('USDC', {
      apiKey: 'sk',
      registry: registryWith(BOTH),
      fetchImpl: apiAnswering({ apy: 12, assets: [{ address: VAULT_USDC, symbol: 'USDC' }] }),
    })

    expect(rate).toBeUndefined()
  })

  it('offers nothing when the API reports no APY', async () => {
    const rate = await readDefindexRate('XLM', {
      apiKey: 'sk',
      registry: registryWith(BOTH),
      fetchImpl: apiAnswering({ assets: [{ address: XLM_SAC }] }),
    })

    expect(rate).toBeUndefined()
  })

  it('offers nothing when the registry lists no vault for the asset', async () => {
    const rate = await readDefindexRate('XLM', {
      apiKey: 'sk',
      registry: registryWith({ usdc_paltalabs_vault: USDC_VAULT }),
      fetchImpl: apiAnswering({ apy: 19.4, assets: [{ address: XLM_SAC }] }),
    })

    expect(rate).toBeUndefined()
  })
})

describe('finding the vault a deposit would go to', () => {
  // The sequence asks this before its first signature. A vault with no APY
  // yet is still a vault the user may have named, so the answer carries the
  // vault with the rate absent rather than declining outright.
  it('names the vault even when the API has no APY for it yet', async () => {
    const found = await readDefindexVaultFor('XLM', {
      apiKey: 'sk',
      registry: registryWith(BOTH),
      fetchImpl: apiAnswering({ assets: [{ address: XLM_SAC }] }),
    })

    expect(found).toEqual({ vault: XLM_VAULT })
  })

  it('still declines a vault holding the wrong asset', async () => {
    const found = await readDefindexVaultFor('USDC', {
      apiKey: 'sk',
      registry: registryWith(BOTH),
      fetchImpl: apiAnswering({ apy: 12, assets: [{ address: VAULT_USDC }] }),
    })

    expect(found).toBeUndefined()
  })
})
