import { stellarNetwork } from '@intent/config'
import {
  Address,
  Asset,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk'

import { applySlippage, isNative, toBaseUnits, type ClassicAsset } from './assets'
import { labelForCall, lookupContract } from './contract-registry'
import type { AggregatorPlatform, SoroswapApi } from './soroswap-api'
import type { AggregatorQuoted } from './sources/soroswap-aggregator-quoter'

/**
 * Admitting a transaction somebody else built.
 *
 * Every other builder here constructs its own envelope and re-reads it as a
 * belt-and-braces check on its own inputs. This one receives an envelope from
 * Soroswap's API server, so the re-read is not a second check — it is the
 * only one. Between a network response and a wallet prompt, this file is the
 * whole distance.
 *
 * The discipline is the offramp's (`assertOfframpPayment`): every field is
 * read back out of the bytes and compared against what *this app* knows the
 * quote said, not against what the API said about its own transaction. The
 * source is the user, the recipient is the user, the contract is one the
 * registry has reviewed, the function is the fixed-input swap, the input is
 * the quoted input, the floor is inside the quoted output's slippage band,
 * and the deadline is in the future. Anything else is refused by name.
 *
 * Three shapes, because the API chooses per quote which contract fills the
 * swap, and each has the recipient in a different place:
 *
 * - `aggregator`: `swap_exact_tokens_for_tokens(token_in, token_out,
 *   amount_in, amount_out_min, distribution, to, deadline)` — recipient sixth.
 * - `router`: the same function on Soroswap's router, `(amount_in,
 *   amount_out_min, path, to, deadline)` — recipient fourth.
 * - `sdex`: a classic `pathPaymentStrictSend` — recipient is `destination`.
 *
 * The platform the quote named decides which shape is admitted. A swap
 * quoted as a split cannot be signed as a payment, and vice versa: reading
 * one layout as another checks the wrong positions.
 */

export interface AggregatorExpectation {
  platform: AggregatorPlatform
  /** The contract a `router` or `aggregator` call must target. Absent for `sdex`. */
  contractId?: string | undefined
  /** Stellar Asset Contract ids. */
  assetIn: string
  assetOut: string
  /** The same assets, in classic form, for the `sdex` shape. */
  from: ClassicAsset
  to: ClassicAsset
  /** Base units. */
  amountIn: string
  amountOut: string
  slippageBps: number
}

export interface CheckedAggregatorSwap {
  /** The floor written into the transaction, read from the bytes. Base units. */
  floor: string
  /** The account the transaction pays, read from the bytes. */
  recipient: string
  /** What the review screen names it, from the registry. */
  label: string
}

export interface AssertClock {
  /** Injected in tests, so a deadline can be judged against a fixed moment. */
  nowSeconds?: () => number
}

const EXACT_IN = 'swap_exact_tokens_for_tokens'

function refuse(detail: string): never {
  throw new Error(`refusing to sign: ${detail}`)
}

/** An address argument as a string, or a refusal naming the position. */
function addressArg(args: xdr.ScVal[], index: number, what: string): string {
  const arg = args[index]
  if (arg === undefined) refuse(`the ${what} argument is missing`)
  try {
    return Address.fromScVal(arg).toString()
  } catch {
    return refuse(`the ${what} argument is not an address`)
  }
}

/** An integer argument as a string, or a refusal naming the position. */
function integerArg(args: xdr.ScVal[], index: number, what: string): string {
  const arg = args[index]
  if (arg === undefined) refuse(`the ${what} argument is missing`)
  const native = scValToNative(arg) as unknown
  if (typeof native !== 'bigint' && typeof native !== 'number') {
    refuse(`the ${what} argument is not an integer`)
  }
  return BigInt(native as bigint | number).toString()
}

/**
 * The floor against the quote. Below the tolerance it protects nothing;
 * above the quoted output it cannot be cleared and fails after a signature.
 */
function checkFloor(floor: string, expected: AggregatorExpectation): void {
  const least = BigInt(applySlippage(expected.amountOut, expected.slippageBps))
  if (BigInt(floor) < least) {
    refuse(
      `the floor ${floor} is below the ${least.toString()} the quote allows at ${expected.slippageBps} bps`
    )
  }
  if (BigInt(floor) > BigInt(expected.amountOut)) {
    refuse(`the floor ${floor} is above the ${expected.amountOut} quoted, and could never fill`)
  }
}

function checkEndpoints(path: unknown, what: string, expected: AggregatorExpectation): void {
  if (!Array.isArray(path) || path.length < 2) refuse(`the ${what} names no route`)
  const first = path[0]
  const last = path[path.length - 1]
  if (first !== expected.assetIn || last !== expected.assetOut) {
    refuse(`the ${what} does not run from the quoted ${expected.from.code} to ${expected.to.code}`)
  }
}

function checkDeadline(deadline: string, nowSeconds: number): void {
  if (BigInt(deadline) <= BigInt(nowSeconds)) {
    refuse(`the deadline ${deadline} has already passed`)
  }
}

interface DecodedInvoke {
  type?: string
  source?: string
  func?: {
    type?: string
    invokeContract?: { contractAddress?: xdr.ScAddress; functionName?: unknown; args?: xdr.ScVal[] }
  }
}

interface DecodedPathPayment {
  type?: string
  source?: string
  destination?: string
  sendAsset?: Asset
  sendAmount?: string
  destAsset?: Asset
  destMin?: string
}

function assetMatches(asset: Asset | undefined, expected: ClassicAsset): boolean {
  if (asset === undefined) return false
  if (isNative(expected)) return asset.isNative()
  return !asset.isNative() && asset.code === expected.code && asset.issuer === expected.issuer
}

function assertContractCall(
  op: DecodedInvoke,
  account: string,
  expected: AggregatorExpectation,
  nowSeconds: number
): CheckedAggregatorSwap {
  if (op.type !== 'invokeHostFunction') {
    refuse(
      `operation ${String(op.type)} is not a contract invocation, which a ${expected.platform} plan needs`
    )
  }
  const host = op.func
  if (host?.type !== 'hostFunctionTypeInvokeContract' || host.invokeContract === undefined) {
    refuse('this is not a contract invocation')
  }
  const invocation = host.invokeContract

  let contractId: string | undefined
  try {
    contractId =
      invocation.contractAddress === undefined
        ? undefined
        : Address.fromScAddress(invocation.contractAddress).toString()
  } catch {
    contractId = undefined
  }
  if (contractId === undefined) refuse('the contract being called could not be read')
  if (contractId !== expected.contractId) {
    refuse(`${contractId} is not the contract the quote named (${String(expected.contractId)})`)
  }

  // The registry is the allowlist, checked after the quote's own id: a
  // contract resolved at runtime and echoed back is still not one this app
  // signs calls to until it has been reviewed and listed.
  const functionName = String(invocation.functionName ?? '')
  const resolved = labelForCall(contractId, functionName)
  if (!resolved.ok) refuse(resolved.reason)
  if (functionName !== EXACT_IN) {
    refuse(`${functionName} is not ${EXACT_IN}, which a fixed-input quote executes as`)
  }

  const args = invocation.args ?? []
  let floor: string
  let recipient: string

  if (expected.platform === 'aggregator') {
    if (args.length !== 7) {
      refuse(`an aggregator swap takes seven arguments, found ${args.length}`)
    }
    const tokenIn = addressArg(args, 0, 'token_in')
    const tokenOut = addressArg(args, 1, 'token_out')
    if (tokenIn !== expected.assetIn) {
      refuse(`the swap spends ${tokenIn}, not the ${expected.from.code} quoted`)
    }
    if (tokenOut !== expected.assetOut) {
      refuse(`the swap delivers ${tokenOut}, not the ${expected.to.code} quoted`)
    }
    const amountIn = integerArg(args, 2, 'amount_in')
    if (amountIn !== expected.amountIn) {
      refuse(`the swap spends ${amountIn}, not the ${expected.amountIn} quoted`)
    }
    floor = integerArg(args, 3, 'amount_out_min')
    checkFloor(floor, expected)

    // Each leg of the split runs between the quoted assets. A leg that ends
    // somewhere else is a swap into a token nobody asked for, split-sized.
    const distribution = args[4] === undefined ? undefined : (scValToNative(args[4]) as unknown)
    if (!Array.isArray(distribution) || distribution.length === 0) {
      refuse('the swap names no distribution')
    }
    for (const leg of distribution as { path?: unknown }[]) {
      checkEndpoints(leg?.path, 'distribution', expected)
    }

    recipient = addressArg(args, 5, 'to')
    checkDeadline(integerArg(args, 6, 'deadline'), nowSeconds)
  } else {
    if (args.length !== 5) {
      refuse(`a router swap takes five arguments, found ${args.length}`)
    }
    const amountIn = integerArg(args, 0, 'amount_in')
    if (amountIn !== expected.amountIn) {
      refuse(`the swap spends ${amountIn}, not the ${expected.amountIn} quoted`)
    }
    floor = integerArg(args, 1, 'amount_out_min')
    checkFloor(floor, expected)
    checkEndpoints(
      args[2] === undefined ? undefined : (scValToNative(args[2]) as unknown),
      'path',
      expected
    )
    recipient = addressArg(args, 3, 'to')
    checkDeadline(integerArg(args, 4, 'deadline'), nowSeconds)
  }

  if (recipient !== account) {
    refuse(
      `the swap pays ${recipient}, not the signing account. ` +
        'A swap must pay the account that funds it.'
    )
  }

  return { floor, recipient, label: resolved.label }
}

function assertPathPayment(
  op: DecodedPathPayment,
  account: string,
  expected: AggregatorExpectation
): CheckedAggregatorSwap {
  if (op.type !== 'pathPaymentStrictSend') {
    refuse(`operation ${String(op.type)} is not a path payment, which a classic-DEX plan needs`)
  }
  if (op.destination !== account) {
    refuse(
      `the payment pays ${op.destination ?? 'nobody'}, not the signing account. ` +
        'A swap must pay the account that funds it.'
    )
  }
  if (!assetMatches(op.sendAsset, expected.from)) {
    refuse(
      `the payment spends ${op.sendAsset?.code ?? 'nothing'}, not the ${expected.from.code} quoted`
    )
  }
  if (!assetMatches(op.destAsset, expected.to)) {
    refuse(
      `the payment delivers ${op.destAsset?.code ?? 'nothing'}, not the ${expected.to.code} quoted`
    )
  }
  // Compared in stroops: the decoded operation carries display amounts.
  const sendAmount = op.sendAmount === undefined ? undefined : toBaseUnits(op.sendAmount)
  if (sendAmount !== expected.amountIn) {
    refuse(`the payment spends ${sendAmount ?? 'nothing'}, not the ${expected.amountIn} quoted`)
  }
  if (op.destMin === undefined) refuse('the payment names no floor')
  const floor = toBaseUnits(op.destMin)
  checkFloor(floor, expected)

  return { floor, recipient: account, label: 'Swap via Soroswap aggregator (classic DEX)' }
}

/**
 * Admits the API's transaction only when every field is the quote's.
 *
 * Read from the bytes, not from the arguments, for the reason every
 * assertion here gives: what is about to be signed is what the bytes say.
 * Here it is doubly so, since the bytes were never this app's to begin with.
 */
export function assertAggregatorSwap(
  built: string,
  account: string,
  expected: AggregatorExpectation,
  clock: AssertClock = {}
): CheckedAggregatorSwap {
  const nowSeconds = clock.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

  const decoded = TransactionBuilder.fromXDR(built, stellarNetwork.networkPassphrase)
  // A fee bump wraps another transaction, so the operations visible here are
  // not the ones that would execute. The API's sponsored flows produce one;
  // this app never asks for those, and refuses the shape outright.
  if (decoded instanceof FeeBumpTransaction) {
    refuse('fee-bump transactions are not accepted from the aggregator')
  }
  const tx = decoded

  if (tx.source !== account) {
    refuse(`transaction source ${tx.source} is not the account`)
  }
  if (tx.operations.length !== 1) {
    refuse(`expected exactly one operation, found ${tx.operations.length}`)
  }
  const op = tx.operations[0] as unknown as { source?: string } | undefined
  if (op === undefined) refuse('the transaction has no operation')
  if (op.source !== undefined && op.source !== account) {
    refuse(`the operation is sourced from ${op.source}, not the signing account`)
  }

  return expected.platform === 'sdex'
    ? assertPathPayment(op as DecodedPathPayment, account, expected)
    : assertContractCall(op as DecodedInvoke, account, expected, nowSeconds())
}

export interface BuildAggregatorSwapOptions {
  /** The account spending, and the only account that may receive. */
  account: string
  /** A fresh quote with its raw API object, from `quoteWithRaw`. */
  quoted: AggregatorQuoted
  api: SoroswapApi
  nowSeconds?: () => number
}

export interface BuiltAggregatorSwap {
  xdr: string
  /** Read from the bytes, not from the quote. Base units. */
  floor: string
  recipient: string
  sendAmount: string
  platform: AggregatorPlatform
  label: string
  networkPassphrase: string
  /**
   * What the envelope was checked against, so a caller that simulates and
   * reassembles it can run the same check on the bytes that come back.
   */
  expectation: AggregatorExpectation
}

/**
 * Asks the API for the transaction and admits it, or throws naming why not.
 *
 * The contract a `router` plan must target is resolved here, at build time,
 * the same way the aggregator's was at quote time — and must be in the
 * registry, for the same reason.
 */
export async function buildAggregatorSwap(
  options: BuildAggregatorSwapOptions
): Promise<BuiltAggregatorSwap> {
  const { account, quoted, api } = options
  const platform = quoted.raw.platform

  let contractId: string | undefined
  if (platform === 'aggregator') {
    contractId = quoted.aggregatorId
  } else if (platform === 'router') {
    contractId = await api.contractAddress('router')
    if (contractId === undefined) {
      throw new Error(
        'the Soroswap router id could not be resolved, so a router plan cannot be checked'
      )
    }
    if (lookupContract(contractId) === undefined) {
      throw new Error(
        `refusing to sign: the API names router ${contractId}, which this app has not reviewed`
      )
    }
  }

  const built = await api.build(quoted.raw, account)
  if (!built.ok) {
    throw new Error(`the aggregator could not build the swap: ${built.detail ?? built.reason}`)
  }

  const expectation: AggregatorExpectation = {
    platform,
    contractId,
    assetIn: quoted.raw.assetIn,
    assetOut: quoted.raw.assetOut,
    from: quoted.quote.from,
    to: quoted.quote.to,
    amountIn: quoted.raw.amountIn,
    amountOut: quoted.raw.amountOut,
    slippageBps: quoted.slippageBps,
  }

  const checked = assertAggregatorSwap(
    built.value,
    account,
    expectation,
    options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}
  )

  return {
    xdr: built.value,
    floor: checked.floor,
    recipient: checked.recipient,
    sendAmount: quoted.raw.amountIn,
    platform,
    label: checked.label,
    networkPassphrase: stellarNetwork.networkPassphrase,
    expectation,
  }
}
