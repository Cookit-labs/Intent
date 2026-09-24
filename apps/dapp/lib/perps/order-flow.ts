import { stellarNetwork } from '@intent/config'
import { StrKey } from '@stellar/stellar-sdk'

import { toBaseUnits } from '../swap/assets'
import { assertPerpOrder } from './assert-order'
import type { NoetherClient, NoetherContracts } from './noether-client'
import { NoetherHttpError, NoetherOfflineError } from './noether-client'
import type { Simulate, SimulatedOpen } from './simulate-order'
import { readSimulatedOpen } from './simulate-order'
import { assertVenueOn } from '../venues'

/**
 * The server's half of opening a position.
 *
 * The gateway builds the envelope, this app never does; what this app does
 * is refuse to pass on anything it has not read. The prepared envelope is
 * compared with the request before the browser sees it, and the signed copy
 * is compared again before it is forwarded, both times against contract ids
 * resolved from the gateway at that moment rather than pinned.
 *
 * Between those two reads the envelope is also simulated here, not only by
 * the gateway. The gateway's simulation is what assembled the footprint; this
 * one yields the `Position` the contract would create — entry and
 * liquidation price computed by the contract at the current oracle price —
 * which is the only honest source for the review card.
 */

/** The gateway's own bound: `leverage: integer, minimum 1, maximum 10`. */
export const MAX_LEVERAGE = 10

export interface OrderRequest {
  account: string
  asset: string
  side: 'long' | 'short'
  /** Display units of the market's USDC, as typed. */
  collateral: string
  /** 7-decimal base units, derived once here. */
  collateralBase: string
  leverage: number
}

export function validateOrderRequest(
  body: unknown
): { ok: true; request: OrderRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>

  const account = b['account']
  if (typeof account !== 'string' || !StrKey.isValidEd25519PublicKey(account)) {
    return { ok: false, error: 'account must be a Stellar public key' }
  }
  const asset = b['asset']
  if (typeof asset !== 'string' || !/^[A-Za-z0-9]{2,12}$/.test(asset)) {
    return { ok: false, error: 'asset must be a market symbol' }
  }
  const side = b['side']
  if (side !== 'long' && side !== 'short') {
    return { ok: false, error: 'side must be long or short' }
  }
  const leverage = b['leverage']
  if (
    typeof leverage !== 'number' ||
    !Number.isInteger(leverage) ||
    leverage < 1 ||
    leverage > MAX_LEVERAGE
  ) {
    return { ok: false, error: `leverage must be a whole number from 1 to ${MAX_LEVERAGE}` }
  }
  const collateral = b['collateral']
  if (typeof collateral !== 'string' || !/^\d+(?:\.\d+)?$/.test(collateral)) {
    return { ok: false, error: 'collateral must be a positive amount of USDC' }
  }
  let collateralBase: string
  try {
    collateralBase = toBaseUnits(collateral)
  } catch {
    return { ok: false, error: 'collateral must be a positive amount of USDC' }
  }
  if (BigInt(collateralBase) <= BigInt(0)) {
    return { ok: false, error: 'collateral must be a positive amount of USDC' }
  }

  return {
    ok: true,
    request: {
      account,
      asset: asset.toUpperCase(),
      side,
      collateral,
      collateralBase,
      leverage,
    },
  }
}

export interface PreparedOrder {
  xdr: string
  contracts: NoetherContracts
  version: string
  /** The oracle's mark price when prepared, 7 decimals. */
  markPrice: string
  markPriceUsd: number
  /** The worst fill the gateway allowed; '0' is unbounded. */
  acceptablePrice: string
  /** What the contract would open, from simulation. */
  position: SimulatedOpen
}

export type OrderFailure = { ok: false; code: string; error: string; hash?: string }

function failure(e: unknown): OrderFailure {
  if (e instanceof NoetherOfflineError) return { ok: false, code: 'offline', error: e.message }
  if (e instanceof NoetherHttpError)
    return { ok: false, code: e.code ?? 'gateway', error: e.message }
  return { ok: false, code: 'refused', error: e instanceof Error ? e.message : String(e) }
}

export async function prepareOrder(options: {
  client: NoetherClient
  simulate: Simulate
  token: string
  request: OrderRequest
}): Promise<{ ok: true; prepared: PreparedOrder } | OrderFailure> {
  const { client, simulate, token, request } = options

  // Testnet-only venue: refused in the same shape as a paused market, before
  // the gateway is asked for anything.
  try {
    assertVenueOn('noether')
  } catch (e) {
    return failure(e)
  }

  let health
  try {
    health = await client.readHealth()
  } catch (e) {
    return failure(e)
  }
  if (health.paused) {
    return {
      ok: false,
      code: 'paused',
      error: 'Noether has paused its market; no position can be opened.',
    }
  }

  let market
  try {
    market = (await client.readMarkets()).find((m) => m.asset === request.asset)
  } catch (e) {
    return failure(e)
  }
  if (market === undefined) {
    return { ok: false, code: 'unknown_market', error: `Noether lists no ${request.asset} market.` }
  }

  let prepared
  try {
    prepared = await client.prepareOpen({
      token,
      asset: request.asset,
      collateral: request.collateralBase,
      leverage: request.leverage,
      side: request.side,
    })
  } catch (e) {
    return failure(e)
  }

  // Read back before the browser sees it. The gateway is trusted to build a
  // valid envelope, not to build the one asked for.
  let read
  try {
    read = assertPerpOrder(prepared.xdr, {
      account: request.account,
      contracts: health.contracts,
      asset: request.asset,
      collateral: request.collateralBase,
      leverage: request.leverage,
      side: request.side,
    })
  } catch (e) {
    return failure(e)
  }

  const simulated = await readSimulatedOpen(prepared.xdr, simulate)
  if (!simulated.ok) {
    // The gateway simulated this moments ago. A failure now is the oracle
    // gone stale or a balance that fell short, and a signature would only
    // pay a fee to learn that on-chain.
    return {
      ok: false,
      code: 'simulation',
      error: `The order does not simulate: ${simulated.reason}`,
    }
  }

  return {
    ok: true,
    prepared: {
      xdr: prepared.xdr,
      contracts: health.contracts,
      version: health.version,
      markPrice: market.markPrice,
      markPriceUsd: market.markPriceUsd,
      acceptablePrice: read.acceptablePrice,
      position: simulated.position,
    },
  }
}

export async function submitOrder(options: {
  client: NoetherClient
  token: string
  request: OrderRequest
  signedXdr: string
}): Promise<{ ok: true; hash: string; ledger?: number; explorerUrl: string } | OrderFailure> {
  const { client, token, request, signedXdr } = options

  // The contracts are resolved again here rather than carried from prepare:
  // two independent reads bracket the signature, and an envelope that
  // matched the first and not the second is refused.
  let health
  try {
    health = await client.readHealth()
  } catch (e) {
    return failure(e)
  }

  try {
    assertPerpOrder(signedXdr, {
      account: request.account,
      contracts: health.contracts,
      asset: request.asset,
      collateral: request.collateralBase,
      leverage: request.leverage,
      side: request.side,
    })
  } catch (e) {
    return failure(e)
  }

  let result
  try {
    result = await client.submit({ token, signedXdr })
  } catch (e) {
    return failure(e)
  }

  if (result.status === 'SUCCESS') {
    return {
      ok: true,
      hash: result.hash,
      ...(result.ledger !== undefined ? { ledger: result.ledger } : {}),
      explorerUrl: `${stellarNetwork.blockExplorerUrl}/tx/${result.hash}`,
    }
  }
  if (result.status === 'PENDING') {
    return {
      ok: false,
      code: 'pending',
      hash: result.hash,
      error:
        'The transaction is still pending on the network. Check the explorer before trying again.',
    }
  }
  const detail =
    result.contractError !== undefined
      ? `${result.contractError.name} (#${result.contractError.code})`
      : result.hostError !== undefined
        ? `${result.hostError.type}: ${result.hostError.code}`
        : (result.txResultCode ?? 'no detail from the gateway')
  return {
    ok: false,
    code: 'failed',
    hash: result.hash,
    error: `The transaction failed on-chain: ${detail}.`,
  }
}
