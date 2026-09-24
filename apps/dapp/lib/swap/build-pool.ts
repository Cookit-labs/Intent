import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  LiquidityPoolAsset,
  Memo,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk'

import type { ClassicAsset } from './assets'
import { isNative } from './assets'
import { resolveVerifiedAsset } from './asset-registry'
import { resolveTradableAsset } from './testnet-assets'
import type { PriceFraction } from './limit-price'
import { assertVenueOn } from '../venues'

/**
 * Depositing into and withdrawing from Stellar's built-in liquidity pools.
 *
 * A fourth transaction shape, kept separate for the same reason as the other
 * three: each builder asserts one operation type, and widening any of them to
 * admit another would weaken the guarantee it exists to make.
 *
 * **The guarantee here is inherent rather than asserted.** A pool deposit has
 * no destination and no recipient argument — shares go to whoever signs, and
 * the operation has nowhere to say otherwise. So unlike a path payment there
 * is nothing to pin. What still needs checking is the envelope: a deposit
 * sharing a transaction with a payment would move funds anywhere at all.
 *
 * **The real risk in a deposit is price, not theft.** Adding liquidity to a
 * pool whose ratio has moved since you looked means buying the worse side at a
 * bad rate, and the loss is silent. The operation therefore takes explicit
 * price bounds and the network rejects anything outside them — the same
 * discipline as `destMin` on a swap, applied to a different failure.
 */

/** Marks a pool operation this app produced. Text memos cap at 28 bytes. */
export const POOL_MEMO = 'intent:pool:v1'

const TIMEOUT_SECONDS = 180

/** Every Stellar pool today. Passed explicitly rather than assumed. */
const FEE_BP = 30

function toSdkAsset(asset: ClassicAsset): Asset {
  if (isNative(asset)) return Asset.native()
  if (asset.issuer === undefined) throw new Error(`asset ${asset.code} needs an issuer`)
  return new Asset(asset.code, asset.issuer)
}

/**
 * Refuses an asset the app has not admitted through either tier.
 *
 * Both tiers, because pool assets are legitimately unverifiable on testnet —
 * of 142 issuers in funded pools, 139 publish no domain. What must not happen
 * is an asset reaching a builder having passed through neither.
 */
function requireTradable(asset: ClassicAsset): void {
  if (resolveVerifiedAsset(asset.code) !== undefined) return
  const known = resolveTradableAsset(asset.code)
  if (known === undefined || known.issuer !== asset.issuer) {
    throw new Error(`${asset.code} is not a verified asset`)
  }
}

/**
 * The pool two assets share.
 *
 * Stellar identifies a pool by its assets in a canonical order, so passing
 * them the other way round addresses a different pool — or nothing at all.
 * `LiquidityPoolAsset` sorts them, which is why the caller does not have to.
 */
function poolFor(a: ClassicAsset, b: ClassicAsset): { id: string; asset: LiquidityPoolAsset } {
  const [first, second] = [toSdkAsset(a), toSdkAsset(b)]
  const ordered = Asset.compare(first, second) <= 0 ? [first, second] : [second, first]
  const asset = new LiquidityPoolAsset(ordered[0] as Asset, ordered[1] as Asset, FEE_BP)
  // The SDK returns a Uint8Array, not a Buffer, so `.toString('hex')` on it
  // yields a comma-separated list of byte values rather than hex — which the
  // operation then rejects as invalid hex at position 2. Converted explicitly.
  return { id: Buffer.from(getLiquidityPoolId('constant_product', asset)).toString('hex'), asset }
}

async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error('This account is not funded yet, so it cannot provide liquidity.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export interface BuildPoolDepositOptions {
  account: string
  assetA: ClassicAsset
  assetB: ClassicAsset
  /** Most of each asset to contribute, in display units. */
  maxAmountA: string
  maxAmountB: string
  /** The band of pool ratios this deposit accepts. */
  minPrice: PriceFraction
  maxPrice: PriceFraction
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltPoolOp {
  xdr: string
  poolId: string
  networkPassphrase: string
}

export interface BuiltPoolDeposit extends BuiltPoolOp {
  minPrice: PriceFraction
  maxPrice: PriceFraction
}

export async function buildPoolDeposit(
  options: BuildPoolDepositOptions
): Promise<BuiltPoolDeposit> {
  assertVenueOn('stellar-pools')
  const { account, assetA, assetB, maxAmountA, maxAmountB, minPrice, maxPrice } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (Number(maxAmountA) <= 0 || Number(maxAmountB) <= 0) {
    throw new Error('a deposit needs a positive amount on both sides')
  }
  requireTradable(assetA)
  requireTradable(assetB)

  // A minimum above the maximum accepts nothing, so the transaction could only
  // ever fail. Better said here than after a wallet prompt.
  if (minPrice.n / minPrice.d > maxPrice.n / maxPrice.d) {
    throw new Error('price range is inverted: the minimum is above the maximum')
  }

  const pool = poolFor(assetA, assetB)
  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      Operation.liquidityPoolDeposit({
        liquidityPoolId: pool.id,
        // Ordered to match the pool, not the caller's argument order.
        maxAmountA:
          Asset.compare(toSdkAsset(assetA), toSdkAsset(assetB)) <= 0 ? maxAmountA : maxAmountB,
        maxAmountB:
          Asset.compare(toSdkAsset(assetA), toSdkAsset(assetB)) <= 0 ? maxAmountB : maxAmountA,
        minPrice,
        maxPrice,
      })
    )
    .addMemo(Memo.text(POOL_MEMO))
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  assertSelfPoolOp(xdr, account)

  return {
    xdr,
    poolId: pool.id,
    minPrice,
    maxPrice,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }
}

export interface BuildPoolWithdrawOptions {
  account: string
  assetA: ClassicAsset
  assetB: ClassicAsset
  /** Pool shares to burn. */
  shares: string
  /** The least of each asset the withdrawal will accept. */
  minAmountA: string
  minAmountB: string
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltPoolWithdraw extends BuiltPoolOp {
  minAmountA: string
  minAmountB: string
}

export async function buildPoolWithdraw(
  options: BuildPoolWithdrawOptions
): Promise<BuiltPoolWithdraw> {
  assertVenueOn('stellar-pools')
  const { account, assetA, assetB, shares, minAmountA, minAmountB } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  if (Number(shares) <= 0) {
    throw new Error('a withdrawal needs a positive number of shares')
  }

  const pool = poolFor(assetA, assetB)
  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      // The floors are the same protection `destMin` gives a swap: shares are
      // worth whatever the pool holds now, so a withdrawal into a drained pool
      // reverts rather than returning dust.
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: pool.id,
        amount: shares,
        minAmountA,
        minAmountB,
      })
    )
    .addMemo(Memo.text(POOL_MEMO))
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  assertSelfPoolOp(xdr, account)

  return {
    xdr,
    poolId: pool.id,
    minAmountA,
    minAmountB,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone pool
 * operation from this account.
 *
 * The operation itself cannot pay a third party — there is no field for one —
 * so what this guards is the envelope. A deposit riding alongside a payment
 * would be a transfer with an alibi, and the single-operation rule is what
 * makes that impossible rather than merely unlikely.
 */
export function assertSelfPoolOp(xdr: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase)

  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.operations.length !== 1) {
    throw new Error(`expected exactly one operation, found ${tx.operations.length}`)
  }

  const op = tx.operations[0]
  if (op === undefined) throw new Error('transaction has no operation')

  if (op.type !== 'liquidityPoolDeposit' && op.type !== 'liquidityPoolWithdraw') {
    throw new Error(
      `operation ${op.type} is not a liquidity pool operation. ` +
        'Only a deposit or withdrawal may be built here.'
    )
  }

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }
}

/** The pool id two assets share, for callers that only need to look it up. */
export function poolIdFor(a: ClassicAsset, b: ClassicAsset): string {
  return poolFor(a, b).id
}
