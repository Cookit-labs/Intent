import { stellarNetwork } from '@intent/config'
import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
} from '@stellar/stellar-sdk'

import { resolveAsset } from '../../swap/assets'
import { sacFor } from '../../swap/build-soroban'
import { requestDeposit, type DefindexApiOptions } from './api'
import { resolveDefindexVault, type ContractsRegistry } from './contracts'
import { readVaultAssets, type VaultAsset } from './vault'

/**
 * A deposit into a DeFindex vault: built elsewhere, admitted here.
 *
 * This is the one envelope in the app that comes from a third party's server
 * rather than from this code. Blend's supply is built here and re-read as a
 * formality; DeFindex's is built by its API and re-read because that is the
 * only check there is. So the assertion is the feature. The transaction must
 * be sourced by the signer, contain exactly one call, to the vault the plan
 * resolved, named `deposit`, funded `from` the signer, of exactly the planned
 * amount, with a floor no higher than that amount. A well-formed envelope
 * pointed anywhere else is refused by the field that differs, the same
 * discipline `assertOfframpPayment` applies to the anchor's payment.
 *
 * The call shape `deposit(amounts_desired: Vec<i128>, amounts_min:
 * Vec<i128>, from: Address, invest: bool)` was verified by simulating one
 * against the live testnet XLM vault on 2026-09-23: 1 XLM returned
 * `[[10000000], 5996, [null]]` — the amounts taken, the shares minted, and
 * the allocation.
 *
 * **A second, separately signed step.** Like a Blend supply this cannot share
 * a transaction with the swap before it (Soroban permits one operation per
 * transaction), so it is sequenced by `use-sequence.ts`: build after the swap
 * settles, sized to what arrived, then sign, then submit through the relay.
 */

export interface DepositExpectation {
  /** The vault the plan resolved. Read from the registry, never from the client. */
  vault: string
  /** Base units. */
  amount: string
}

function refuse(field: string, detail: string): never {
  throw new Error(`refusing to sign deposit: ${field} — ${detail}`)
}

/** The decoded operation, as stellar-base hands it back: plain objects, not XDR unions. */
interface DecodedInvocation {
  type?: string
  func?: {
    type?: string
    invokeContract?: {
      contractAddress?: Parameters<typeof Address.fromScAddress>[0]
      functionName?: unknown
      args?: Parameters<typeof scValToNative>[0][]
    }
  }
}

/**
 * Admits a deposit only when every field is the plan's.
 *
 * Read back out of the XDR, not taken from the API's reply: what is about to
 * be signed is what the bytes say, and the bytes came from somebody else's
 * server and are about to go through a browser and a wallet extension.
 */
export function assertDefindexDeposit(
  built: string,
  account: string,
  expectation: DepositExpectation
): void {
  const decoded = TransactionBuilder.fromXDR(built, stellarNetwork.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction) {
    refuse('shape', 'fee-bump transactions are not signed here; the relay adds its own')
  }
  const tx = decoded

  if (tx.source !== account) refuse('source', `${tx.source} is not the signing account`)

  if (tx.operations.length !== 1) {
    refuse('operations', `exactly one deposit is expected, found ${tx.operations.length}`)
  }
  const op = tx.operations[0] as unknown as DecodedInvocation
  if (op.type !== 'invokeHostFunction') {
    refuse('operation', `${op.type ?? 'unknown'} is not a contract invocation`)
  }
  if (op.func?.type !== 'hostFunctionTypeInvokeContract') {
    refuse('operation', 'this is not a contract invocation')
  }

  const invocation = op.func.invokeContract
  if (invocation === undefined || invocation.contractAddress === undefined) {
    refuse('contract', 'the call could not be read')
  }
  const contract = Address.fromScAddress(invocation.contractAddress).toString()
  if (contract !== expectation.vault) {
    refuse('contract', `${contract} is not the vault the plan resolved (${expectation.vault})`)
  }

  // `functionName` decodes to an `XdrString`, not a plain string.
  const functionName = String(invocation.functionName)
  if (functionName !== 'deposit') refuse('function', `${functionName} is not a deposit`)

  const args = invocation.args ?? []
  if (args.length !== 4) refuse('arguments', `a deposit takes four arguments, found ${args.length}`)

  const desired = amountsOf(args[0], 'amounts')
  const expected = BigInt(expectation.amount)
  if (desired[0] !== expected) {
    refuse('amount', `${desired[0]} is not the ${expectation.amount} planned`)
  }

  const minimum = amountsOf(args[1], 'minimum')
  if (minimum[0] < BigInt(0) || minimum[0] > expected) {
    refuse('minimum', `${minimum[0]} is above the ${expectation.amount} deposited`)
  }

  const from = Address.fromScVal(args[2] as Parameters<typeof Address.fromScVal>[0]).toString()
  if (from !== account) {
    refuse('from', `the deposit names ${from} as from, not the signing account`)
  }

  if (typeof scValToNative(args[3] as Parameters<typeof scValToNative>[0]) !== 'boolean') {
    refuse('invest', 'expected a boolean')
  }
}

/** One i128 per asset. The vaults this app uses hold one asset, so one entry is the only accepted shape. */
function amountsOf(arg: unknown, field: string): [bigint] {
  const native = scValToNative(arg as Parameters<typeof scValToNative>[0]) as unknown
  if (!Array.isArray(native) || !native.every((v) => typeof v === 'bigint')) {
    refuse(field, 'could not be read')
  }
  const amounts = native as bigint[]
  if (amounts.length !== 1) {
    refuse(field, `a deposit here names one asset, found ${amounts.length}`)
  }
  return [amounts[0] as bigint]
}

export interface BuildDefindexDepositOptions extends DefindexApiOptions {
  /** The depositor, and the only account the deposit may be funded from. */
  account: string
  /** The asset by ticker. Resolved to a vault through the registry and to a contract through the SDK. */
  symbol: string
  /** Base units. */
  amount: string
  registry?: ContractsRegistry
  /** Injected in tests: the vault's `get_assets`, read from the chain. */
  readAssets?: (vault: string) => Promise<VaultAsset[]>
}

export interface BuiltDefindexDeposit {
  xdr: string
  vault: string
  /** Ticker. */
  asset: string
  /** The asset's contract id, as the vault holds it. */
  assetContract: string
  amount: string
  /** Echoed back and asserted: the account whose shares these become. */
  recipient: string
  networkPassphrase: string
}

/**
 * Resolves the vault, checks it holds the asset, asks the API for the
 * envelope, and admits it.
 *
 * Three refusals before the API is asked for anything: an asset this app
 * does not trade, a vault the registry no longer lists, and a vault that
 * holds something other than what the swap delivers. Each is named, because
 * "the deposit could not be built" would send someone looking in the wrong
 * place for all three.
 */
export async function buildDefindexDeposit(
  options: BuildDefindexDepositOptions
): Promise<BuiltDefindexDeposit> {
  const { account, symbol, amount } = options

  const asset = resolveAsset(symbol)
  if (asset === undefined) throw new Error(`${symbol} is not an asset this app trades`)
  const assetContract = sacFor(asset)

  const vault = await resolveDefindexVault(symbol, {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
  })
  if (vault === undefined) {
    throw new Error(`DeFindex has no ${symbol} vault on testnet right now`)
  }

  const held = await (options.readAssets ?? readVaultAssets)(vault.id)
  const addresses = held.map((a) => a.address)
  if (addresses.length !== 1 || addresses[0] !== assetContract) {
    throw new Error(
      `DeFindex's ${symbol} vault holds ${addresses.join(', ') || 'nothing'}, ` +
        `not the ${symbol} this app trades (${assetContract})`
    )
  }

  const xdr = await requestDeposit({ vault: vault.id, account, amount }, options)
  assertDefindexDeposit(xdr, account, { vault: vault.id, amount })

  return {
    xdr,
    vault: vault.id,
    asset: symbol,
    assetContract,
    amount,
    recipient: account,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }
}
