import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import type { ClassicAsset } from './assets'
import { isNative, toBaseUnits } from './assets'
import type { PriceFraction } from './limit-price'

/**
 * Turning a limit price into an order that rests on Stellar's book.
 *
 * Deliberately a sibling of `build-tx.ts` rather than an extension of it. That
 * file's `assertSelfSwap` demands a path payment whose destination equals its
 * source, which is precisely what makes an agent unable to route funds to a
 * third party. An offer operation satisfies none of those checks, and loosening
 * them to admit one would weaken the guarantee for swaps too.
 *
 * The same security property is reached differently here, and more cheaply: a
 * manage-offer operation **has no destination field**. There is nowhere to put
 * a recipient, so the proceeds can only ever land in the account that placed
 * the order. What still has to be checked is the envelope — an offer alongside
 * a payment would be a transfer with an alibi — so the assertion below is about
 * the whole transaction rather than the offer alone.
 */

/**
 * Marks an order this app placed.
 *
 * Separate from the swap memo so history can tell a resting order from an
 * immediate trade. Stellar text memos cap at 28 bytes.
 */
export const OFFER_MEMO = 'intent:limit:v1'

/** Long enough to review and sign, short enough not to linger unsigned. */
const TIMEOUT_SECONDS = 180

/** Stellar's sentinel for "this is a new offer" rather than an edit. */
const NEW_OFFER = '0'

export interface BuildOfferOptions {
  /** The account placing the order, and the only one that can receive from it. */
  account: string
  /** What is being given up. */
  selling: ClassicAsset
  /** What is wanted in return. */
  buying: ClassicAsset
  /** Display units of the selling asset. Zero cancels an existing offer. */
  amount: string
  /** Exact ratio, in buying units per selling unit. */
  price: PriceFraction
  /**
   * The offer to replace. Absent places a new one.
   *
   * Cancelling is the same operation with an amount of zero and the live id:
   * Stellar has no delete, and an order with nothing left on it is removed.
   */
  offerId?: string
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export interface BuiltOffer {
  /** Unsigned envelope, ready for the wallet. */
  xdr: string
  /** Echoed so the caller knows whether this creates or replaces. */
  offerId: string
  amount: string
  price: PriceFraction
  networkPassphrase: string
}

function toSdkAsset(asset: ClassicAsset): Asset {
  if (isNative(asset)) return Asset.native()
  if (asset.issuer === undefined) throw new Error(`asset ${asset.code} needs an issuer`)
  return new Asset(asset.code, asset.issuer)
}

/**
 * Reads the account's sequence number over plain REST.
 *
 * The SDK's own server client would do this, but it drags in the full Horizon
 * wrapper for one field, and `stellar-account.ts` already established that
 * reading account state here is a single GET.
 */
async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) {
    throw new Error('This account is not funded yet, so it cannot place an order.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)

  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export async function buildOfferTransaction(options: BuildOfferOptions): Promise<BuiltOffer> {
  const { account, selling, buying, amount, price } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch
  const offerId = options.offerId ?? NEW_OFFER

  if (price.n <= 0 || price.d <= 0) {
    throw new Error('an offer price must be a positive ratio')
  }
  // Rejects more precision than the ledger keeps, rather than rounding it away
  // behind the user's back. Also normalises the display form the SDK wants.
  const normalised = formatAmount(amount)

  if (normalised === '0.0000000' && offerId === NEW_OFFER) {
    throw new Error('an offer of zero would place nothing and cancel nothing')
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      Operation.manageSellOffer({
        selling: toSdkAsset(selling),
        buying: toSdkAsset(buying),
        amount: normalised,
        // The exact rational, not a decimal. The price recorded on the ledger
        // is then the price that was meant, with no float in between.
        price,
        offerId,
      })
    )
    .addMemo(Memo.text(OFFER_MEMO))
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  assertSelfOffer(xdr, account)

  return {
    xdr,
    offerId,
    amount: normalised,
    price,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }
}

/** Display form at the ledger's precision, refusing anything finer. */
function formatAmount(amount: string): string {
  // Round-trips through base units so the 7-decimal limit is enforced by the
  // same code that enforces it for swaps, rather than a second rule that could
  // drift from it.
  const base = BigInt(toBaseUnits(amount))
  const whole = base / BigInt(10_000_000)
  const fraction = (base % BigInt(10_000_000)).toString().padStart(7, '0')
  return `${whole.toString()}.${fraction}`
}

/**
 * Re-reads the built transaction and refuses anything that is not a lone offer
 * from this account.
 *
 * Checks the encoded bytes rather than the inputs, for the same reason
 * `assertSelfSwap` does: the inputs are already known to be right, and what
 * matters is that what is about to be signed says what we think it says. It
 * also catches a future edit that adds an operation without noticing what that
 * would allow — an offer cannot pay a third party, but a payment sharing its
 * envelope certainly can.
 */
export function assertSelfOffer(xdr: string, account: string): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase)

  // A fee bump wraps another transaction, so its operations are not the ones
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

  if (
    op.type !== 'manageSellOffer' &&
    op.type !== 'manageBuyOffer' &&
    op.type !== 'createPassiveSellOffer'
  ) {
    throw new Error(
      `operation ${op.type} is not an offer. ` +
        'Only an offer may be placed here: it has no destination field, so it ' +
        'cannot move funds to a third party.'
    )
  }

  if (tx.source !== account) {
    throw new Error(`refusing to sign: transaction source ${tx.source} is not the account`)
  }
}
