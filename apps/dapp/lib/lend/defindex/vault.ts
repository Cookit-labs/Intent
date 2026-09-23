import { stellarTestnet } from '@intent/config'
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'

/**
 * Reading a DeFindex vault from the chain.
 *
 * Read-only and unsigned, like `reserves.ts`: a simulation, verifiable
 * against testnet without a wallet. The API also reports what a vault holds,
 * and the market context trusts it for the menu; the build path does not.
 * Before anything is signed, the vault's own `get_assets` is read here and
 * compared to the asset the swap delivers.
 *
 * Why that comparison is not pedantry, measured 2026-09-23: DeFindex's
 * testnet USDC vault holds `CAQCFV…`, a different USDC from the Circle-issued
 * one this app trades (`CBIELT…`). A ticker match would have sent the wrong
 * asset to a contract that would refuse it after the swap had settled.
 */

/** Any account works: a simulation touches neither balance nor sequence. */
const READ_ONLY_SOURCE = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'

export interface VaultStrategy {
  address: string
  name: string
  paused: boolean
}

/** One entry of the vault's `AssetStrategySet` vector. */
export interface VaultAsset {
  /** The asset's contract id. */
  address: string
  strategies: VaultStrategy[]
}

export interface ReadVaultOptions {
  rpcUrl?: string
  /** Injected in tests, so the decoding is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

export async function readVaultAssets(
  vault: string,
  options: ReadVaultOptions = {}
): Promise<VaultAsset[]> {
  const server =
    options.serverImpl ?? new rpc.Server(options.rpcUrl ?? stellarTestnet.sorobanRpcUrl)

  const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(new Contract(vault).call('get_assets'))
    .setTimeout(60)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    // A deleted contract — what a testnet reset leaves behind — answers with
    // a storage error, which is the message worth surfacing.
    throw new Error(`DeFindex vault get_assets failed: ${sim.error}`)
  }
  if (sim.result === undefined) throw new Error('DeFindex vault get_assets returned nothing')

  const raw = scValToNative(sim.result.retval) as unknown
  if (!Array.isArray(raw)) throw new Error('DeFindex vault returned an unreadable asset list')

  return raw.map((entry) => {
    const record = entry as { address?: unknown; strategies?: unknown }
    const strategies = Array.isArray(record.strategies) ? record.strategies : []
    return {
      address: asString(record.address),
      strategies: strategies.map((s) => {
        const strategy = s as { address?: unknown; name?: unknown; paused?: unknown }
        return {
          address: asString(strategy.address),
          name: asString(strategy.name),
          paused: strategy.paused === true,
        }
      }),
    }
  })
}
