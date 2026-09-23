import { Asset, Networks } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import {
  createContractsRegistry,
  resolveDefindexVault,
  type ContractsRegistry,
  type DefindexVault,
} from '../lend/defindex/contracts'
import { readVaultAssets, type VaultAsset } from '../lend/defindex/vault'
import { USDC } from '../swap/assets'
import { sacFor } from '../swap/build-soroban'

/**
 * The registry and the chain agree about DeFindex's testnet vaults.
 *
 * Everything else about DeFindex is stubbed, which is right for the
 * assertion logic and useless for the question that matters: does the file
 * DeFindex publishes name a contract that exists, and does that contract
 * hold what this app would deposit into it? A key was not available when
 * this was written, so the API is not exercised here; the registry and the
 * vault contract are public and are.
 *
 * Marked `.live` and skippable: `SKIP_LIVE=1` turns it off, and a network
 * that does not answer skips rather than fails, since neither the file nor
 * the chain being unreachable says anything about this code. A vault the
 * file no longer lists skips too — that is a testnet reset, which the app
 * handles as "offline". A contract that answers with an error does fail:
 * the registry naming a vault that does not exist is a finding.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

interface Live {
  vault: DefindexVault | undefined
  assets: VaultAsset[] | undefined
  /** The contract's own error, when it answered with one. */
  error?: string
}

/** Read once at load, so the tests below can be skipped rather than failed when nothing answers. */
async function readLive(
  symbol: string,
  registry: ContractsRegistry
): Promise<Live | 'unreachable'> {
  let vault: DefindexVault | undefined
  try {
    vault = await resolveDefindexVault(symbol, { registry })
  } catch {
    return 'unreachable'
  }
  if (vault === undefined) return { vault: undefined, assets: undefined }

  try {
    return { vault, assets: await readVaultAssets(vault.id) }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The contract answering with an error is a finding; the network not
    // answering is not.
    if (message.startsWith('DeFindex vault get_assets failed')) {
      return { vault, assets: undefined, error: message }
    }
    return 'unreachable'
  }
}

const registry = createContractsRegistry()
const xlm = SKIP ? 'unreachable' : await readLive('XLM', registry)
const usdc = SKIP ? 'unreachable' : await readLive('USDC', registry)

describe('the DeFindex testnet vaults the registry names', () => {
  it.skipIf(xlm === 'unreachable' || xlm.vault === undefined)(
    'lists an XLM vault that exists on-chain and holds the native SAC',
    () => {
      if (xlm === 'unreachable') return
      expect(xlm.error).toBeUndefined()
      expect(xlm.assets?.map((a) => a.address)).toEqual([
        Asset.native().contractId(Networks.TESTNET),
      ])
      // The strategy behind it is Blend's, which is why the risks card says
      // Blend's risks apply underneath.
      expect(xlm.assets?.[0]?.strategies.map((s) => s.name)).toContain('XLM Blend Strategy')
    }
  )

  it.skipIf(usdc === 'unreachable' || usdc.vault === undefined)(
    'lists a USDC vault holding a USDC this app does not trade',
    () => {
      // Measured 2026-09-23 and the reason the asset check is on-chain rather
      // than by ticker. If this ever fails, the vault now holds Circle's
      // testnet USDC and the market context may legitimately start offering
      // it — check the rate reader's asset comparison before celebrating.
      if (usdc === 'unreachable') return
      expect(usdc.error).toBeUndefined()
      expect(usdc.assets).toHaveLength(1)
      expect(usdc.assets?.[0]?.address).not.toBe(sacFor(USDC))
    }
  )
})
