import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import { memoFromAnchor, memoMatches } from '../offramp/memo'
import { toBaseUnits } from '../swap/assets'

/**
 * The send payment: one classic `payment` to somebody the user named.
 *
 * Built and admitted the way the offramp payment is, field for field. The
 * difference is where the expectation comes from. The anchor's payment is
 * checked against what the anchor said; this one is checked against what the
 * *name* resolved to, on the server, at the moment of building and again at
 * the moment of submitting. A name is a pointer somebody else controls, and
 * the second resolution is what catches it moving between review and
 * signature.
 *
 * The memo is the recipient's when they named one — a federation answer for
 * an exchange is a pooled account plus a memo saying whose deposit this is,
 * and a payment that drops it lands in the pool and is nobody's. Otherwise it
 * is the user's own, or absent, and an envelope carrying a memo nobody asked
 * for is refused as firmly as one missing the memo somebody did.
 */

const TIMEOUT_SECONDS = 180

export interface SendExpectation {
  /** As typed, for the refusal message. */
  recipientInput: string
  /** What the recipient resolved to, on the server. */
  destination: string
  memo?: string
  memoType?: 'text' | 'id' | 'hash'
  /** Display units. */
  amount: string
  /** The classic asset; no issuer means native XLM. */
  asset: { code: string; issuer?: string }
}

function assetOf(expectation: SendExpectation): Asset {
  return expectation.asset.issuer === undefined
    ? Asset.native()
    : new Asset(expectation.asset.code, expectation.asset.issuer)
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

export interface BuildSendOptions {
  account: string
  expectation: SendExpectation
  horizonUrl?: string
  fetchImpl?: typeof fetch
}

export async function buildSendPayment(
  options: BuildSendOptions
): Promise<{ xdr: string; networkPassphrase: string }> {
  const { account, expectation } = options
  const horizonUrl = options.horizonUrl ?? stellarNetwork.horizonUrl
  const fetchImpl = options.fetchImpl ?? fetch

  // Refused before Horizon is asked: a payment to oneself is never what
  // "send" meant, and the assertion below would refuse it anyway.
  if (expectation.destination === account) {
    throw new Error(`refusing to build send: ${expectation.recipientInput} is yourself`)
  }

  const sequence = await loadSequence(account, horizonUrl, fetchImpl)

  const builder = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  }).addOperation(
    Operation.payment({
      destination: expectation.destination,
      asset: assetOf(expectation),
      amount: expectation.amount,
    })
  )
  if (expectation.memo !== undefined && expectation.memoType !== undefined) {
    builder.addMemo(memoFromAnchor(expectation.memo, expectation.memoType))
  }
  const xdr = builder.setTimeout(TIMEOUT_SECONDS).build().toXDR()

  // The builder's own output is checked the same way a signed envelope will
  // be, as every builder in this app does.
  assertSendPayment(xdr, account, expectation)

  return { xdr, networkPassphrase: stellarNetwork.networkPassphrase }
}

function refuse(field: string, detail: string): never {
  throw new Error(`refusing to sign send: ${field} — ${detail}`)
}

interface DecodedPayment {
  type: string
  destination?: string
  amount?: string
  asset?: Asset
  source?: string
}

/**
 * Admits a payment only when every field is what the name resolved to.
 *
 * Read back out of the XDR, not taken from the arguments. What is about to be
 * signed is what the bytes say, and the bytes have been through a browser and
 * an extension since they were built.
 */
export function assertSendPayment(
  xdr: string,
  account: string,
  expectation: SendExpectation
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

  if (op.destination === account || expectation.destination === account) {
    refuse('destination', `${expectation.recipientInput} is yourself`)
  }
  if (op.destination !== expectation.destination) {
    // Both addresses, because this is the sentence a moved name produces:
    // the envelope was built for one and the name now points at another.
    refuse(
      'destination',
      `${op.destination ?? 'none'} is not ${expectation.destination}, which ${expectation.recipientInput} resolves to now`
    )
  }

  const asset = op.asset
  const expected = assetOf(expectation)
  if (asset === undefined) refuse('asset', 'the payment names no asset')
  if (expected.isNative()) {
    if (!asset.isNative()) refuse('asset', `${asset.code} is not XLM`)
  } else {
    if (asset.isNative()) refuse('asset', `native XLM is not ${expected.code}`)
    if (asset.code !== expected.code) refuse('asset', `${asset.code} is not ${expected.code}`)
    if (asset.issuer !== expected.issuer) {
      refuse('issuer', `${asset.issuer ?? 'none'} is not the issuer of the app's ${expected.code}`)
    }
  }

  // Compared in stroops, because '5' and '5.0000000' are one amount.
  if (
    op.amount === undefined ||
    BigInt(toBaseUnits(op.amount)) !== BigInt(toBaseUnits(expectation.amount))
  ) {
    refuse('amount', `${op.amount ?? 'none'} is not the ${expectation.amount} named`)
  }

  if (expectation.memo === undefined || expectation.memoType === undefined) {
    if (tx.memo.type !== 'none') {
      refuse(
        'memo',
        `a ${tx.memo.type} memo is attached and ${expectation.recipientInput} named none`
      )
    }
    return
  }
  if (!memoMatches(tx.memo, expectation.memo, expectation.memoType)) {
    refuse(
      'memo',
      `the ${tx.memo.type} memo does not match the ${expectation.memoType} memo ${expectation.recipientInput} named`
    )
  }
}
