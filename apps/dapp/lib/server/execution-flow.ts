import { activeNetwork, stellarNetwork, type StellarNetworkName } from '@intent/config'
import {
  Asset,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk'

import { knownAssetsFor } from '../swap/asset-registry'
import { fromBaseUnits } from '../swap/assets'
import type { MarketPrice } from '../swap/price-types'
import { fetchMarketPrices } from '../swap/prices'
import { soroswapRouter } from '../swap/contract-registry'
import { readContractCall } from '../swap/plan-validator'
import { usdValue } from './trade-cap'

/**
 * What a signed transaction moved, read from its own bytes.
 *
 * The usage log records this beside the hash so volume can be counted without
 * a second trip to the chain. It is the app's own reading, priced by the same
 * oracle the agents use at the time of the submit, and the hash stays beside it
 * so any figure can be checked against the ledger.
 *
 * Only what leaves the account counts: the amount sold, sent or offered. An
 * asset is valued only when it is one the registry verifies for the network, so
 * an issuer's lookalike code is never priced as the real thing. Anything that
 * cannot be read or priced is left empty rather than guessed.
 */

type Op = Transaction['operations'][number]

export interface FlowLeg {
  /** The verified symbol, or `CODE:ISSUER` for an asset the registry does not know. */
  asset: string
  /** Display units. */
  amount: string
  /** Whether the registry vouches for the asset, so its price can be trusted. */
  verified: boolean
  /** What the leg bought, when the operation says. */
  into?: string
}

export interface ExecutionFlow {
  assetIn: string
  amountIn: string
  assetOut: string | null
  /** Dollars, or null when no leg could be priced. */
  volumeUsd: number | null
}

function nameOf(asset: Asset, network: StellarNetworkName): { name: string; verified: boolean } {
  if (asset.isNative()) return { name: 'XLM', verified: true }
  const code = asset.getCode()
  const issuer = asset.getIssuer()
  const known = Object.values(knownAssetsFor(network)).find(
    (a) => a.code === code && a.issuer === issuer
  )
  return known !== undefined
    ? { name: known.code, verified: true }
    : { name: `${code}:${issuer}`, verified: false }
}

function classicLeg(op: Op, network: StellarNetworkName): FlowLeg | undefined {
  const leg = (asset: Asset, amount: string, into?: Asset): FlowLeg => {
    const { name, verified } = nameOf(asset, network)
    const out = into === undefined ? undefined : nameOf(into, network).name
    return { asset: name, amount, verified, ...(out === undefined ? {} : { into: out }) }
  }
  switch (op.type) {
    case 'pathPaymentStrictSend':
      return leg(op.sendAsset, op.sendAmount, op.destAsset)
    case 'pathPaymentStrictReceive':
      // `sendMax` is a ceiling, not what moved; the destination amount is exact.
      return leg(op.destAsset, op.destAmount, op.sendAsset)
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return leg(op.selling, op.amount, op.buying)
    case 'manageBuyOffer':
      return leg(op.buying, op.buyAmount, op.selling)
    case 'payment':
      return leg(op.asset, op.amount)
    default:
      return undefined
  }
}

function contractLeg(op: Op, network: StellarNetworkName): FlowLeg | undefined {
  if (op.type !== 'invokeHostFunction') return undefined
  const func = (op as unknown as { func?: { type?: string; invokeContract?: unknown } }).func
  if (func?.type !== 'hostFunctionTypeInvokeContract') return undefined
  const call = func.invokeContract as
    | { contractAddress?: unknown; functionName?: unknown; args?: xdr.ScVal[] }
    | undefined
  if (call === undefined || String(call.functionName) !== 'swap_exact_tokens_for_tokens') {
    return undefined
  }

  // Only the Soroswap router's layout is read: (amount_in, amount_out_min, path, to, deadline).
  const args = call.args ?? []
  if (args.length !== 5) return undefined
  try {
    const amountIn = scValToNative(args[0] as xdr.ScVal) as bigint
    const path = scValToNative(args[2] as xdr.ScVal) as string[]
    const first = path[0]
    const last = path[path.length - 1]
    if (first === undefined) return undefined

    const bySac = new Map<string, { name: string; verified: boolean }>()
    for (const a of Object.values(knownAssetsFor(network))) {
      const asset = a.issuer === undefined ? Asset.native() : new Asset(a.code, a.issuer)
      bySac.set(asset.contractId(stellarNetwork.networkPassphrase), {
        name: a.code,
        verified: true,
      })
    }
    const sold = bySac.get(first)
    const bought = last === undefined ? undefined : bySac.get(last)
    return {
      asset: sold?.name ?? first,
      amount: fromBaseUnits(amountIn.toString()),
      verified: sold !== undefined,
      ...(bought === undefined ? {} : { into: bought.name }),
    }
  } catch {
    return undefined
  }
}

/** What each operation of the envelope sells, in order. Empty when nothing can be read. */
export function readFlow(
  signedXdr: string,
  network: StellarNetworkName = activeNetwork()
): FlowLeg[] {
  let tx
  try {
    const decoded = TransactionBuilder.fromXDR(signedXdr, stellarNetwork.networkPassphrase)
    tx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded
  } catch {
    return []
  }

  const legs: FlowLeg[] = []
  for (const op of tx.operations) {
    const leg =
      op.type === 'invokeHostFunction'
        ? readContractCall(op).contractId === soroswapRouter()
          ? contractLeg(op, network)
          : undefined
        : classicLeg(op, network)
    if (leg !== undefined) legs.push(leg)
  }
  return legs
}

/** The legs as one record: the first leg names the trade, every priced leg adds to the dollars. */
export function summariseFlow(
  legs: FlowLeg[],
  prices: Record<string, MarketPrice>
): ExecutionFlow | undefined {
  const first = legs[0]
  if (first === undefined) return undefined

  let total = 0
  let priced = false
  for (const leg of legs) {
    if (!leg.verified) continue
    const usd = usdValue(leg.asset, leg.amount, prices)
    if (Number.isFinite(usd)) {
      total += usd
      priced = true
    }
  }
  return {
    assetIn: first.asset,
    amountIn: first.amount,
    assetOut: first.into ?? null,
    volumeUsd: priced ? Math.round(total * 100) / 100 : null,
  }
}

const PRICE_TTL_MS = 60_000
const PRICE_WAIT_MS = 1_500

const priceCache = globalThis as unknown as {
  intentFlowPrices?: { at: number; table: Record<string, MarketPrice> }
}

async function currentPrices(): Promise<Record<string, MarketPrice> | undefined> {
  const held = priceCache.intentFlowPrices
  if (held !== undefined && Date.now() - held.at < PRICE_TTL_MS) return held.table
  try {
    const table = await Promise.race([
      fetchMarketPrices(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no price in time')), PRICE_WAIT_MS)
      ),
    ])
    priceCache.intentFlowPrices = { at: Date.now(), table }
    return table
  } catch {
    return undefined
  }
}

/**
 * What the usage log records for a submitted transaction. Never throws: an
 * unreadable envelope or an unreachable oracle just leaves the figures empty.
 */
export async function describeExecution(signedXdr: string): Promise<ExecutionFlow | undefined> {
  const legs = readFlow(signedXdr)
  if (legs.length === 0) return undefined
  const prices = await currentPrices()
  return summariseFlow(legs, prices ?? {})
}
