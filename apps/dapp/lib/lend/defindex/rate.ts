import { resolveAsset } from '../../swap/assets'
import { sacFor } from '../../swap/build-soroban'
import { readVault, type DefindexApiOptions } from './api'
import { resolveDefindexVault, type ContractsRegistry } from './contracts'

/**
 * The one figure the agents are told about DeFindex: what its vault pays.
 *
 * Composed from the registry (which vault) and the API (what it holds and
 * what it yields), and undefined whenever the figure would be wrong to
 * offer. An agent given no rate simply will not propose the venue, which is
 * the safe reading of every reason below.
 */

export interface DefindexRate {
  vault: string
  /** 7-day trailing yield, annualised, as a percentage, net of vault fees. */
  apy: number
}

export interface ReadDefindexRateOptions extends DefindexApiOptions {
  registry?: ContractsRegistry
}

export interface DefindexVaultFor {
  vault: string
  /** Absent when the API has no figure yet. */
  apy?: number
}

/**
 * The vault a deposit of this asset would go to, with its rate when known.
 *
 * Undefined, not an error, for: an asset this app does not trade, a vault
 * the registry does not list, and a vault holding a different asset from
 * the one a swap would deliver (DeFindex's testnet USDC vault does, measured
 * 2026-09-23). A vault with no APY yet is still returned: the sequence asks
 * this before its first signature, and a vault the user named is a vault
 * whether or not the API has a figure for it. Only a failed read throws.
 */
export async function readDefindexVaultFor(
  symbol: string,
  options: ReadDefindexRateOptions = {}
): Promise<DefindexVaultFor | undefined> {
  const asset = resolveAsset(symbol)
  if (asset === undefined) return undefined

  const vault = await resolveDefindexVault(symbol, {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
  })
  if (vault === undefined) return undefined

  const info = await readVault(vault.id, options)

  // The API's word is enough for the menu; the build path checks the chain.
  const held = info.assets.map((a) => a.address)
  if (held.length !== 1 || held[0] !== sacFor(asset)) return undefined

  return { vault: vault.id, ...(info.apy !== undefined ? { apy: info.apy } : {}) }
}

/**
 * The same, for the market context: nothing unless there is a rate to
 * offer. An agent given no rate simply will not propose the venue, and the
 * market context turns a failed read into silence.
 */
export async function readDefindexRate(
  symbol: string,
  options: ReadDefindexRateOptions = {}
): Promise<DefindexRate | undefined> {
  const found = await readDefindexVaultFor(symbol, options)
  return found?.apy === undefined ? undefined : { vault: found.vault, apy: found.apy }
}
