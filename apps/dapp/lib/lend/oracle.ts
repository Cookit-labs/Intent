import { stellarTestnet } from '@intent/config'
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { BLEND_POOL } from '../swap/contract-registry'

/**
 * The prices Blend liquidates against.
 *
 * **A third XLM price, and the only one that matters here.** This app already
 * reads two others — testnet's order book, which says what a swap fills near,
 * and mainnet's, which says what the asset is really worth. Neither governs a
 * lending position. The pool values collateral and debt with its own oracle,
 * so a health factor computed from any other source would disagree with the
 * contract that can seize the collateral.
 *
 * The gap is not small: the oracle reads XLM at $0.42 while testnet's book
 * reads $0.114. Using the wrong one would misstate a liquidation price by a
 * factor of four.
 *
 * **On testnet these prices are mock and admin-settable** — XLM $0.42, wETH
 * $4,000, wBTC $100,000, USDC $1.00, all suspiciously round. They are real for
 * testnet and say nothing about mainnet, and anything displaying them should
 * not imply otherwise.
 */

/** Reading needs a source account; any funded one does, and this never signs. */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export interface OraclePrice {
  /** USD, in the oracle's own fixed point. */
  price: bigint
  /** Decimals the oracle reports in. Seven on this pool. */
  decimals: number
  /** When the oracle last updated, as a unix timestamp. */
  timestamp: number
}

export interface OracleOptions {
  poolId?: string
  oracleId?: string
  rpcUrl?: string
  /** Injected in tests, so price handling is checkable without a network. */
  serverImpl?: Pick<rpc.Server, 'simulateTransaction'>
}

function serverFor(options: OracleOptions): Pick<rpc.Server, 'simulateTransaction'> {
  return options.serverImpl ?? new rpc.Server(options.rpcUrl ?? stellarTestnet.sorobanRpcUrl)
}

async function call(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  options: OracleOptions
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(60)
    .build()

  const sim = await serverFor(options).simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`oracle ${fn} failed: ${sim.error}`)
  }
  if (sim.result === undefined) throw new Error(`oracle ${fn} returned nothing`)

  return scValToNative(sim.result.retval)
}

/**
 * Which oracle this pool uses.
 *
 * Read from the pool rather than hardcoded: the oracle is a pool setting, and
 * a stale address here would price a position against a contract the pool does
 * not consult.
 */
export async function readOracleId(options: OracleOptions = {}): Promise<string> {
  if (options.oracleId !== undefined) return options.oracleId

  const config = (await call(options.poolId ?? BLEND_POOL, 'get_config', [], options)) as
    | { oracle?: string }
    | undefined

  const oracle = config?.oracle
  if (typeof oracle !== 'string' || oracle === '') {
    throw new Error('the pool reported no oracle')
  }
  return oracle
}

/**
 * The asset argument, as SEP-40 expects it.
 *
 * An enum, not an address: `Stellar(address)` for a contract-issued asset,
 * `Other(symbol)` for anything else. Passing the address alone fails with
 * `Error(WasmVm, InvalidAction)`, which names nothing about the argument shape
 * and cost several attempts to diagnose.
 */
function stellarAsset(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    nativeToScVal('Stellar', { type: 'symbol' }),
    new Address(contractId).toScVal(),
  ])
}

/**
 * What the pool thinks one asset is worth, in USD.
 *
 * Undefined when the oracle has no price rather than throwing: a missing price
 * for one reserve should not take down a position read that covers several.
 * A caller that cannot proceed without it must say so itself — silently
 * substituting a guess is how a liquidation price becomes fiction.
 */
export async function readPrice(
  asset: string,
  options: OracleOptions = {}
): Promise<OraclePrice | undefined> {
  const oracleId = await readOracleId(options)

  const decimals = (await call(oracleId, 'decimals', [], options)) as number
  const raw = (await call(oracleId, 'lastprice', [stellarAsset(asset)], options)) as
    | { price?: bigint | string | number; timestamp?: bigint | string | number }
    | undefined

  if (raw?.price === undefined) return undefined

  return {
    price: BigInt(String(raw.price)),
    decimals: typeof decimals === 'number' ? decimals : 7,
    timestamp: Number(raw.timestamp ?? 0),
  }
}

/**
 * Prices for several assets at once.
 *
 * The oracle id and its decimals are read once rather than per asset, which is
 * most of the cost — each price is a separate simulation either way.
 */
export async function readPrices(
  assets: string[],
  options: OracleOptions = {}
): Promise<Record<string, OraclePrice>> {
  const oracleId = await readOracleId(options)
  const withOracle: OracleOptions = { ...options, oracleId }

  const found: Record<string, OraclePrice> = {}
  for (const asset of assets) {
    const price = await readPrice(asset, withOracle)
    if (price !== undefined) found[asset] = price
  }
  return found
}
