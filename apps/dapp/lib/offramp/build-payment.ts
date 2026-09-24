// apps/dapp/lib/offramp/build-payment.ts
import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import { USDC, toBaseUnits } from '../swap/assets'
import type { AnchorEntry } from './anchors'
import { memoFromAnchor, memoMatches } from './memo'
import type { AnchorTransaction, Sep24MemoType } from './sep24'
import { isReadyToPay } from './sep24'

/**
 * The offramp payment: the one transaction this app builds that pays somebody
 * other than the signer.
 *
 * `plan-validator.ts` refuses `payment` by name, because a plan must never
 * move funds to a third party. This does not weaken that rule. The payment is
 * built alone — one operation, its own envelope, like a Blend supply — and it
 * is admitted by an assertion of its own that checks every field against what
 * the anchor said about *this* withdrawal, read by the server, at the moment
 * of building and again at the moment of submitting.
 *
 * Three ways this loses money silently, all from the SEP-24 specification:
 * sending before the anchor is ready; a memo that is missing or of the wrong
 * type on an account the anchor shares with every other user; and a
 * destination cached from a previous withdrawal, because anchors rotate
 * pooled accounts. Each is a named refusal below.
 */

const TIMEOUT_SECONDS = 180

export interface OfframpExpectation {
  anchorId: string
  transactionId: string
  /** `withdraw_anchor_account`, from this transaction's own response. */
  destination: string
  /** `withdraw_memo`, verbatim — base64 for a hash. */
  memo: string
  memoType: Sep24MemoType
  /** `amount_in`, display units. */
  amount: string
  assetCode: string
  assetIssuer: string
}

/**
 * What the anchor expects, or a reason it cannot be paid yet.
 *
 * Only a ready transaction yields an expectation. Before
 * `pending_user_transfer_start` the destination fields may be absent or, worse,
 * present and stale — so readiness is checked first and the fields second.
 */
export function expectationFrom(anchor: AnchorEntry, tx: AnchorTransaction): OfframpExpectation {
  if (!isReadyToPay(tx.status)) {
    throw new Error(`the anchor is not ready for payment: status is ${tx.status}`)
  }
  if (tx.withdrawAnchorAccount === undefined || tx.withdrawAnchorAccount === '') {
    throw new Error('the anchor named no destination account')
  }
  if (tx.withdrawMemo === undefined || tx.withdrawMemoType === undefined) {
    throw new Error('the anchor named no memo, and a payment without one cannot be attributed')
  }
  if (tx.amountIn === undefined || tx.amountIn === '') {
    throw new Error('the anchor named no amount')
  }

  // What the mapper passed through is checked here, at the gate. A wire
  // `null` arrives as the string "null"; an account that is not a public
  // key would fail inside the SDK with a message about nothing.
  try {
    toBaseUnits(tx.amountIn)
  } catch {
    throw new Error(`the anchor named an amount that is not a number: ${tx.amountIn}`)
  }
  if (!StrKey.isValidEd25519PublicKey(tx.withdrawAnchorAccount)) {
    throw new Error(
      `the anchor named a destination that is not an account: ${tx.withdrawAnchorAccount}`
    )
  }

  // The asset the anchor names, when it names one, must be the app's USDC.
  // Two anchors already differ on which USDC they mean (Blend's is a third
  // issuer again), and a payment in the wrong one is a payment the anchor
  // never sees.
  const issuer = USDC.issuer as string
  if (tx.amountInAsset !== undefined) {
    const expected = `stellar:${USDC.code}:${issuer}`
    if (tx.amountInAsset !== expected) {
      throw new Error(`the anchor asked for asset ${tx.amountInAsset}, not ${expected}`)
    }
  }

  // Built once here so a malformed memo is refused before any envelope
  // exists, rather than at signing time.
  memoFromAnchor(tx.withdrawMemo, tx.withdrawMemoType)

  return {
    anchorId: anchor.id,
    transactionId: tx.id,
    destination: tx.withdrawAnchorAccount,
    memo: tx.withdrawMemo,
    memoType: tx.withdrawMemoType,
    amount: tx.amountIn,
    assetCode: USDC.code,
    assetIssuer: issuer,
  }
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
    throw new Error('This account is not funded yet, so it cannot pay.')
  }
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export interface BuildOfframpOptions {
  account: string
  expectation: OfframpExpectation
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export async function buildOfframpPayment(
  options: BuildOfframpOptions
): Promise<{ xdr: string; networkPassphrase: string }> {
  const { account, expectation } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: expectation.destination,
        asset: new Asset(expectation.assetCode, expectation.assetIssuer),
        amount: expectation.amount,
      })
    )
    .addMemo(memoFromAnchor(expectation.memo, expectation.memoType))
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  // The builder's own output is checked the same way a signed envelope will
  // be. Every builder in this app does this; the check costs nothing and the
  // one time it fires is the one time it matters.
  assertOfframpPayment(xdr, account, expectation)

  return { xdr, networkPassphrase: stellarNetwork.networkPassphrase }
}

function refuse(field: string, detail: string): never {
  throw new Error(`refusing to sign offramp: ${field} — ${detail}`)
}

interface DecodedPayment {
  type: string
  destination?: string
  amount?: string
  asset?: Asset
  source?: string
}

/**
 * Admits a payment only when every field is the anchor's.
 *
 * Read back out of the XDR, not taken from the arguments — the same
 * discipline as every other assertion here. What is about to be signed is
 * what the bytes say, and the bytes have been through a browser and an
 * extension since they were built.
 */
export function assertOfframpPayment(
  xdr: string,
  account: string,
  expectation: OfframpExpectation
): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction)
    refuse('shape', 'fee-bump transactions are not built here')
  const tx = decoded

  if (tx.source !== account) refuse('source', `${tx.source} is not the signing account`)

  if (tx.operations.length !== 1) {
    refuse('operations', `exactly one payment is expected, found ${tx.operations.length}`)
  }
  const op = tx.operations[0] as unknown as DecodedPayment
  if (op.type !== 'payment') refuse('operation', `${op.type} is not a payment`)
  if (op.source !== undefined && op.source !== account) {
    refuse('operation', `sourced from ${op.source}, not the signing account`)
  }

  if (op.destination !== expectation.destination) {
    refuse('destination', `${op.destination ?? 'none'} is not the account the anchor named`)
  }

  const asset = op.asset
  if (asset === undefined || asset.isNative())
    refuse('asset', 'native XLM is not what the anchor asked for')
  if (asset.code !== expectation.assetCode) {
    refuse('asset', `${asset.code} is not ${expectation.assetCode}`)
  }
  if (asset.issuer !== expectation.assetIssuer) {
    refuse('issuer', `${asset.issuer ?? 'none'} is not the issuer the anchor accepts`)
  }

  // Compared in stroops, because '5' and '5.0000000' are one amount and the
  // anchor may write either.
  if (
    op.amount === undefined ||
    BigInt(toBaseUnits(op.amount)) !== BigInt(toBaseUnits(expectation.amount))
  ) {
    refuse('amount', `${op.amount ?? 'none'} is not the ${expectation.amount} the anchor named`)
  }

  if (!memoMatches(tx.memo, expectation.memo, expectation.memoType)) {
    refuse(
      'memo',
      `the ${tx.memo.type} memo does not match the ${expectation.memoType} memo the anchor named`
    )
  }
}
