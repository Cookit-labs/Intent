import { stellarTestnet } from '@intent/config'
import {
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import type { AssetRef, ClassicAsset } from './assets'
import { applySlippage, fromBaseUnits, isNative } from './assets'
import type { SwapQuote } from './quote'

/**
 * Turns a quoted route into an unsigned transaction.
 *
 * The security property this file exists to enforce: **a swap built here always
 * pays the sender's own account.** A Stellar path payment is a payment — it can
 * send value to anyone — and the agents deciding these routes are language
 * models acting on free text a user typed. So `destination` is not a parameter.
 * It is set to the source and asserted before the transaction is returned. An
 * agent cannot express a transfer to a third party, because there is nowhere in
 * this interface to put one.
 *
 * Slippage protection is the network's job rather than ours: `destMin` is part
 * of the operation, so a path that degrades between quoting and inclusion makes
 * the whole transaction fail rather than fill badly.
 */

/**
 * Marks a transaction as one this app produced.
 *
 * Without it, history can only be "every path payment this account ever made",
 * which includes trades from any other Stellar app the user has touched.
 * Stellar text memos cap at 28 bytes, so this is deliberately terse; the
 * version suffix means the format can change later without silently
 * reinterpreting old transactions.
 */
export const INTENT_MEMO = 'intent:swap:v1'

/** How long a built transaction stays valid. Long enough to sign, short enough not to linger. */
const TIMEOUT_SECONDS = 180

/** Default tolerance if a caller does not state one. 0.5%. */
export const DEFAULT_SLIPPAGE_BPS = 50

export interface BuildSwapOptions {
  /** The account sending *and* receiving. There is deliberately no separate destination. */
  account: string
  quote: SwapQuote
  slippageBps?: number
  horizonUrl?: string
}

export interface BuiltSwap {
  /** Unsigned transaction envelope, ready for the wallet. */
  xdr: string
  /** The floor written into the operation, in base units. */
  destMin: string
  /** Echoed back so the UI can show what was actually committed to. */
  sendAmount: string
  slippageBps: number
  networkPassphrase: string
}

function toSdkAsset(asset: AssetRef): Asset {
  if (asset.kind === 'contract') {
    // Soroban tokens are invoked through a contract, not sent as a classic
    // asset. Reaching here means a Soroswap route was passed to the classic
    // builder, which is a wiring mistake rather than a user error.
    throw new Error(`contract asset ${asset.code} cannot be used in a classic path payment`)
  }
  if (isNative(asset)) return Asset.native()
  if (asset.issuer === undefined) throw new Error(`asset ${asset.code} needs an issuer`)
  return new Asset(asset.code, asset.issuer)
}

export async function buildSwapTransaction(options: BuildSwapOptions): Promise<BuiltSwap> {
  const { account, quote } = options
  const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const horizonUrl = options.horizonUrl ?? stellarTestnet.horizonUrl

  if (quote.source !== 'horizon') {
    throw new Error(`quote from ${quote.source} needs its own builder`)
  }
  // Belt and braces: only Horizon quotes reach here today, and they never set
  // this. If a future source does, a classic path payment would silently
  // deliver a different asset than the one quoted.
  if (quote.deliversAsset !== undefined) {
    throw new Error(`quote from ${quote.source} settles in a non-classic asset`)
  }

  const server = new Horizon.Server(horizonUrl)
  const source = await server.loadAccount(account)

  const sendAsset = toSdkAsset(quote.from)
  const destAsset = toSdkAsset(quote.to)
  const path = quote.path.map(toSdkAsset)

  const destMin = applySlippage(quote.destAmount, slippageBps)

  // Destination is the sender. Stated once, here, and asserted below — this is
  // what makes "the agent cannot move funds to a third party" a property of the
  // code rather than a promise in a prompt.
  const destination = account

  const operation =
    quote.kind === 'strict_receive'
      ? Operation.pathPaymentStrictReceive({
          sendAsset,
          // On a fixed output the quoted input becomes the ceiling, widened by
          // the same tolerance — the direction flips, so it is applied to the
          // send side instead.
          sendMax: fromBaseUnits(widen(quote.sendAmount, slippageBps)),
          destination,
          destAsset,
          destAmount: fromBaseUnits(quote.destAmount),
          path,
        })
      : Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount: fromBaseUnits(quote.sendAmount),
          destination,
          destAsset,
          destMin: fromBaseUnits(destMin),
          path,
        })

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(operation)
    // Stamped so history can tell this app's trades from the rest of the
    // account's activity.
    .addMemo(Memo.text(INTENT_MEMO))
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  assertSelfSwap(tx.toXDR(), account)

  return {
    xdr: tx.toXDR(),
    destMin,
    sendAmount: quote.sendAmount,
    slippageBps,
    networkPassphrase: stellarTestnet.networkPassphrase,
  }
}

/** Widens an amount upward, for the `sendMax` ceiling on a fixed-output swap. */
function widen(baseAmount: string, toleranceBps: number): string {
  return ((BigInt(baseAmount) * BigInt(10_000 + toleranceBps)) / BigInt(10_000)).toString()
}

/**
 * Re-reads the built transaction and refuses anything that is not a self-swap.
 *
 * Deliberately checks the *encoded* transaction rather than the inputs. The
 * inputs are already known to be right; what matters is that the bytes about to
 * be signed say what we think they say. This also catches a future edit that
 * adds an operation without noticing what it allows.
 */
export function assertSelfSwap(xdr: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarTestnet.networkPassphrase)

  // A fee-bump wraps another transaction, so its operations are not the ones
  // that would execute. Refusing outright beats inspecting the wrong envelope.
  if (decoded instanceof FeeBumpTransaction) {
    throw new Error('fee-bump transactions are not supported here')
  }
  const tx = decoded

  if (tx.operations.length !== 1) {
    throw new Error(`expected exactly one operation, found ${tx.operations.length}`)
  }

  const op = tx.operations[0]
  if (op === undefined) throw new Error('transaction has no operation')

  if (op.type !== 'pathPaymentStrictSend' && op.type !== 'pathPaymentStrictReceive') {
    throw new Error(`operation ${op.type} is not a swap`)
  }

  if (op.destination !== account) {
    throw new Error(
      `refusing to sign: destination ${op.destination} is not the sending account. ` +
        'Swaps must return funds to the sender; agents cannot transfer to third parties.'
    )
  }

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }
}

export type { ClassicAsset }
