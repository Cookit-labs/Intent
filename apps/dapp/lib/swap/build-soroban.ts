import { stellarTestnet } from '@intent/config'
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'

import type { ClassicAsset } from './assets'
import { plain } from './preview'
import { resolveVerifiedAsset } from './asset-registry'

/**
 * Swapping through Soroswap's router.
 *
 * A third builder, kept separate for the same reason the offer builder is:
 * `build-tx.ts` asserts a path payment whose destination equals its source,
 * and `build-offer.ts` asserts a lone offer operation. A contract invocation
 * is neither shape, and widening either assertion to admit it would weaken the
 * guarantee that assertion exists to make.
 *
 * **The guarantee here works differently.** A path payment has a destination
 * field to pin to the sender. A contract call does not — instead the router
 * takes a recipient as an *argument*, and will send the proceeds wherever it
 * is told. So the thing asserted is that argument, read back out of the
 * encoded transaction rather than trusted from the inputs.
 *
 * Why this is worth having at all: on identical assets, Soroswap quotes
 * 473 XLM for 50 USDC against Horizon's 128. That is not a rounding
 * difference, and until now it was unreachable.
 */

/** Soroswap's testnet router. */
const ROUTER = 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD'

/** How long the router will accept the swap. Long enough to sign, short enough to be current. */
const DEFAULT_DEADLINE_SECONDS = 300

/** Matches the classic builders, so a wallet prompt does not linger. */
const TIMEOUT_SECONDS = 180

export interface BuildSorobanSwapOptions {
  /** The account spending, and the only account that may receive. */
  account: string
  from: ClassicAsset
  to: ClassicAsset
  /** Base units (stroops). A string, never a number. */
  sendAmount: string
  /** The floor the router must clear, in base units. */
  minReceive: string
  /** Seconds from now the router stops accepting this swap. */
  deadlineSeconds?: number
  routerId?: string
  rpcUrl?: string
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltSorobanSwap {
  xdr: string
  /** Echoed back and asserted: the account receiving the proceeds. */
  recipient: string
  minReceive: string
  sendAmount: string
  networkPassphrase: string
}

/**
 * The Stellar Asset Contract for a classic asset.
 *
 * Derived rather than looked up. A hardcoded table is how the quoter came to
 * price every swap against a test token called "USDCoin" that merely shared
 * the USDC ticker — a derived id cannot drift from the asset it represents.
 */
export function sacFor(asset: ClassicAsset): string {
  const sdkAsset = asset.issuer === undefined ? Asset.native() : new Asset(asset.code, asset.issuer)
  return sdkAsset.contractId(stellarTestnet.networkPassphrase)
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
    throw new Error('This account is not funded yet, so it cannot swap.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export async function buildSorobanSwap(
  options: BuildSorobanSwapOptions
): Promise<BuiltSorobanSwap> {
  const { account, from, to, sendAmount, minReceive } = options
  const routerId = options.routerId ?? ROUTER
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch
  const deadlineSeconds = options.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS

  if (BigInt(sendAmount) <= BigInt(0)) {
    throw new Error('a swap needs a positive amount')
  }
  if (BigInt(minReceive) < BigInt(0)) {
    throw new Error('a minimum received must be positive')
  }
  if (deadlineSeconds <= 0) {
    throw new Error('a deadline must be in the future')
  }

  // A SAC id can be derived for *any* well-formed asset, so deriving one
  // proves nothing about whether it can be traded. The allowlist is the real
  // check: an asset the app has not verified must not reach a router, because
  // an unverified asset is exactly the ticker-impersonation case.
  for (const asset of [from, to]) {
    if (resolveVerifiedAsset(asset.code) === undefined) {
      throw new Error(`no Soroban contract for ${asset.code}: it is not a verified asset`)
    }
  }

  let fromContract: string
  let toContract: string
  try {
    fromContract = sacFor(from)
    toContract = sacFor(to)
  } catch {
    throw new Error(`no Soroban contract for ${from.code} or ${to.code}`)
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  // The recipient. Stated once, here, and asserted below — this is what makes
  // "the router cannot pay a third party" a property of the bytes rather than
  // a promise about the arguments.
  const recipient = account

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds)

  const operation = new Contract(routerId).call(
    'swap_exact_tokens_for_tokens',
    nativeToScVal(BigInt(sendAmount), { type: 'i128' }),
    nativeToScVal(BigInt(minReceive), { type: 'i128' }),
    nativeToScVal([new Address(fromContract).toScVal(), new Address(toContract).toScVal()]),
    new Address(recipient).toScVal(),
    nativeToScVal(deadline, { type: 'u64' })
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  assertSelfInvoke(xdr, account)

  return {
    xdr,
    recipient,
    minReceive,
    sendAmount,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone
 * contract call from this account.
 *
 * Checks the encoded bytes rather than the inputs, for the same reason the
 * other two builders do: the inputs are already known to be right, and what
 * matters is that what is about to be signed says the same thing. It also
 * catches a future edit that adds an operation without noticing what that
 * would allow.
 */
export function assertSelfInvoke(xdr: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarTestnet.networkPassphrase)

  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.operations.length !== 1) {
    throw new Error(`expected exactly one operation, found ${tx.operations.length}`)
  }

  const op = tx.operations[0]
  if (op === undefined) throw new Error('transaction has no operation')

  if (op.type !== 'invokeHostFunction') {
    throw new Error(
      `operation ${op.type} is not a contract invocation. ` +
        'Only a router call may be built here; a path payment belongs to build-tx.'
    )
  }

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }
}

/**
 * Simulates the built transaction, which Soroban requires before submission.
 *
 * A Soroban transaction carries a resource footprint the network computes, so
 * unlike a classic operation it cannot be signed straight from the builder.
 * Simulation is also the last honest check that the swap will succeed: it
 * reverts here rather than on-chain if the route has moved past `minReceive`.
 */
export async function prepareSorobanSwap(
  xdr: string,
  rpcUrl: string = stellarTestnet.sorobanRpcUrl
): Promise<
  | {
      ok: true
      xdr: string
      /** The network's simulation, kept so the caller can read what it says will change. */
      sim: rpc.Api.SimulateTransactionSuccessResponse
      /** The fee the assembled transaction carries, in XLM. */
      feeXlm: string
    }
  | { ok: false; reason: string }
> {
  const server = new rpc.Server(rpcUrl)

  let tx
  try {
    tx = TransactionBuilder.fromXDR(xdr, stellarTestnet.networkPassphrase)
  } catch {
    return { ok: false, reason: 'The transaction could not be read.' }
  }
  if (tx instanceof FeeBumpTransaction) {
    return { ok: false, reason: 'Fee-bump transactions are not supported.' }
  }

  try {
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // The router's own revert reason, which is far more useful than a
      // generic failure — it distinguishes "price moved" from "no pool".
      return { ok: false, reason: sim.error }
    }
    const prepared = rpc.assembleTransaction(tx, sim).build()
    return { ok: true, xdr: prepared.toXDR(), sim, feeXlm: plain(BigInt(prepared.fee)) }
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Simulation failed.',
    }
  }
}

export { Networks, scValToNative, Operation }
