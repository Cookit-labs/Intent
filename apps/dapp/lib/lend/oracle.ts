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
 * A SEP-40 oracle client, serving two oracles that answer different questions.
 *
 * **Blend's pool oracle** is what a lending position is liquidated against.
 * On testnet it is a mock with admin-set prices — XLM $0.42, wBTC $100,000,
 * all suspiciously round — and it is still the only oracle that matters for a
 * health factor, because the pool seizes collateral against *its* feed
 * whatever any other says. `readPrice` and `readOracleId` serve it, and they
 * take the oracle's address from the pool's own config rather than from a
 * constant here.
 *
 * **Reflector** is a real oracle network aggregating CEX and DEX venues. It
 * answers "what is this worth" for agent reasoning and for sizing a dollar
 * amount, and it must never be substituted into the health factor — see the
 * price hierarchy in `lib/swap/prices.ts`.
 *
 * Both speak SEP-40, and they disagree about the one thing a client is most
 * likely to hardcode: the asset enum. Blend addresses assets as
 * `Stellar(contract)`; Reflector's CEX/DEX feed addresses them as
 * `Other("XLM")`. Each returns `null`, not an error, for the other's form.
 * `OracleAsset` exists so a caller says which it means and neither form is
 * assumed.
 */

/** Reading needs a source account; any funded one does, and this never signs. */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export interface OraclePrice {
  /** In the oracle's base currency, in its own fixed point. */
  price: bigint
  /**
   * Decimals the oracle reports in. Read at runtime, never assumed: Blend's
   * mock says 7, Reflector says 14, and a hardcoded either is a 10^7 error
   * that still looks like a price.
   */
  decimals: number
  /** When the oracle last updated, as a unix timestamp. */
  timestamp: number
}

/**
 * How an oracle names an asset.
 *
 * SEP-40's `Asset` enum has two arms, and which one a given oracle populates
 * is not discoverable from the interface — only from asking. Blend's mock
 * lists its reserves as `Stellar(contract)`; Reflector's CEX/DEX feed lists
 * tickers as `Other("XLM")` and returns `null` for the Stellar form of the
 * very same asset.
 */
export type OracleAsset = { kind: 'stellar'; contract: string } | { kind: 'other'; symbol: string }

/** What an oracle says about itself: how to read its numbers and how often they move. */
export interface OracleMeta {
  decimals: number
  /** Seconds between updates, per the oracle. */
  resolution: number
  /** When it last updated, as a unix timestamp. */
  lastTimestamp: number
}

/**
 * How many update periods a price may miss before it is treated as absent.
 *
 * One missed period is ordinary jitter on a five-minute cadence. Two means the
 * feed has stopped, and a price that stopped updating is more dangerous than
 * no price — it looks fine.
 */
const STALE_AFTER_PERIODS = 2

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
 * An enum, not an address. Passing a bare address fails with
 * `Error(WasmVm, InvalidAction)`, which names nothing about the argument shape
 * and cost several attempts to diagnose. Passing the *wrong arm* does not
 * fail at all — it returns `null` — which is the quieter and worse failure.
 */
function assetArg(asset: OracleAsset): xdr.ScVal {
  if (asset.kind === 'stellar') {
    return xdr.ScVal.scvVec([
      nativeToScVal('Stellar', { type: 'symbol' }),
      new Address(asset.contract).toScVal(),
    ])
  }
  return xdr.ScVal.scvVec([
    nativeToScVal('Other', { type: 'symbol' }),
    nativeToScVal(asset.symbol, { type: 'symbol' }),
  ])
}

/**
 * What an oracle reports about its own feed.
 *
 * Three calls, because SEP-40 exposes them separately. `decimals` is needed
 * to read any price; `resolution` and `last_timestamp` together say whether
 * the price is current, which no single call answers.
 */
export async function readOracleMeta(
  oracleId: string,
  options: OracleOptions = {}
): Promise<OracleMeta> {
  const [decimals, resolution, lastTimestamp] = await Promise.all([
    call(oracleId, 'decimals', [], options),
    call(oracleId, 'resolution', [], options),
    call(oracleId, 'last_timestamp', [], options),
  ])

  return {
    decimals: Number(decimals),
    resolution: Number(resolution),
    lastTimestamp: Number(lastTimestamp),
  }
}

/**
 * Whether a price is too old to act on.
 *
 * Judged against the oracle's own cadence rather than a fixed number of
 * seconds, so the same rule is right for a feed that updates every five
 * minutes and one that updates every hour.
 */
export function isStale(
  price: Pick<OraclePrice, 'timestamp'>,
  meta: Pick<OracleMeta, 'resolution'>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (meta.resolution <= 0) return false
  return nowSeconds - price.timestamp > meta.resolution * STALE_AFTER_PERIODS
}

/**
 * A price for an asset named in either enum arm.
 *
 * Undefined when the oracle has no price rather than throwing: a missing price
 * for one asset should not take down a read that covers several. A caller
 * that cannot proceed without it must say so itself — silently substituting a
 * guess is how a liquidation price becomes fiction.
 */
export async function readPriceFor(
  asset: OracleAsset,
  options: OracleOptions = {}
): Promise<OraclePrice | undefined> {
  const oracleId = await readOracleId(options)

  const decimals = (await call(oracleId, 'decimals', [], options)) as number
  const raw = (await call(oracleId, 'lastprice', [assetArg(asset)], options)) as
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
 * What the pool thinks one of its reserves is worth.
 *
 * The `Stellar(contract)` arm, which is how Blend's oracle names reserves.
 * Kept as its own entry point so the position reader — the caller whose
 * mistakes cost the most — cannot accidentally reach for the other form.
 */
export async function readPrice(
  asset: string,
  options: OracleOptions = {}
): Promise<OraclePrice | undefined> {
  return readPriceFor({ kind: 'stellar', contract: asset }, options)
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
