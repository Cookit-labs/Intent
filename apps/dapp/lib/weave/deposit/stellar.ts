import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk'

import {
  ChainActionRefused,
  toBaseUnits,
  type SignedPayload,
  type SigningPayload,
  type SubmitResult,
} from '../../chains/types'
import { USDC, toBaseUnits as toStroops } from '../../swap/assets'
import { balanceOf } from '../../swap/delivered-balance'
import {
  failureMessage,
  submitSignedSwap,
  transactionHashOf,
  type SubmitFailure,
} from '../../swap/submit'
import type { DepositChain, DepositExpectation } from '../types'

const USDC_DECIMALS = 7
const TIMEOUT_SECONDS = 180
const MEMO_TEXT_MAX_BYTES = 28
const HORIZON_TIMEOUT_MS = 10_000

const NOT_SIGNED = 'Nothing was signed or sent.'
// A signed payment refused at submit: the wallet has signed, so only this is true.
const NOT_SENT = 'It was not sent, so no money moved.'

type Refuse = (reason: string) => never

function refuser(ending: string): Refuse {
  return (reason) => {
    throw new ChainActionRefused(`${reason} ${ending}`)
  }
}

const refuseUnsigned = refuser(NOT_SIGNED)

function isPublicKey(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address)
}

function expectedStroops(amount: string, refuse: Refuse): string {
  try {
    return toBaseUnits(amount, USDC_DECIMALS)
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
}

function expectedMemo(expectation: DepositExpectation, refuse: Refuse): string | undefined {
  const { memo } = expectation
  if (memo === undefined) return undefined
  if (memo === '') refuse('This order’s memo is empty, which is not a memo that can be sent.')
  if (Buffer.byteLength(memo, 'utf8') > MEMO_TEXT_MAX_BYTES) {
    refuse(`This order’s memo is longer than the ${MEMO_TEXT_MAX_BYTES} bytes Stellar can carry.`)
  }
  return memo
}

/**
 * Admits one USDC payment from the account to the order's deposit address, read back
 * from the bytes. The memo has to match both ways: the provider credits a deposit by
 * its memo, so a payment without the one it needs can be lost.
 */
function assertPayment(xdr: string, expectation: DepositExpectation, refuse: Refuse): void {
  const { account, depositAddress, amount } = expectation
  const stroops = expectedStroops(amount, refuse)
  const memo = expectedMemo(expectation, refuse)

  let decoded: Transaction | FeeBumpTransaction
  try {
    decoded = TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase)
  } catch {
    return refuse('That transaction could not be read.')
  }
  if (decoded instanceof FeeBumpTransaction) {
    return refuse('A fee bump is not the payment this order asked for.')
  }
  const tx = decoded

  if (tx.source !== account) refuse('That payment is not from this order’s account.')

  const [op] = tx.operations
  if (tx.operations.length !== 1 || op === undefined) {
    return refuse('This order is paid by exactly one payment and nothing else.')
  }
  if (op.type !== 'payment')
    return refuse('This order is paid by a plain payment and nothing else.')
  if (op.source !== undefined && op.source !== account) {
    refuse('That payment spends from another account.')
  }
  if (op.destination !== depositAddress)
    refuse('That payment is not to this order’s deposit address.')
  // Code and issuer both: a look-alike with the same code is a payment the provider never sees.
  if (op.asset.isNative() || op.asset.code !== USDC.code || op.asset.issuer !== USDC.issuer) {
    refuse('This order is paid in the app’s USDC and no other asset.')
  }
  if (toStroops(op.amount) !== stroops) refuse('That payment’s amount is not this order’s amount.')

  if (memo === undefined) {
    if (tx.memo.type !== 'none') refuse('This order has no memo, and that payment carries one.')
    return
  }
  if (tx.memo.type !== 'text') refuse('That payment does not carry the text memo this order needs.')
  const carried = Buffer.from(tx.memo.value as Uint8Array | string)
  if (!carried.equals(Buffer.from(memo, 'utf8'))) {
    refuse('That payment’s memo is not this order’s memo.')
  }
}

function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
  if (payload.family !== 'stellar') {
    return refuseUnsigned('That is not a Stellar transaction.')
  }
  if (payload.account !== expectation.account) {
    refuseUnsigned('That transaction is for another account.')
  }
  assertPayment(payload.xdr, expectation, refuseUnsigned)
}

async function loadSequence(account: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${stellarNetwork.horizonUrl}/accounts/${account}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
    })
  } catch {
    return refuseUnsigned('Could not read this account from the Stellar network.')
  }
  if (res.status === 404) return refuseUnsigned('This account is not funded yet, so it cannot pay.')
  if (!res.ok) return refuseUnsigned('Could not read this account from the Stellar network.')
  const body = (await res.json().catch(() => ({}))) as { sequence?: string }
  if (body.sequence === undefined) {
    return refuseUnsigned('Could not read this account from the Stellar network.')
  }
  return body.sequence
}

async function build(expectation: DepositExpectation): Promise<SigningPayload> {
  const { account, depositAddress, amount } = expectation
  if (!isPublicKey(account)) refuseUnsigned('This order’s account is not a Stellar account.')
  if (!isPublicKey(depositAddress)) {
    refuseUnsigned('This order’s deposit address is not a Stellar account.')
  }
  expectedStroops(amount, refuseUnsigned)
  const memo = expectedMemo(expectation, refuseUnsigned)

  const sequence = await loadSequence(account)
  const builder = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: depositAddress,
        asset: new Asset(USDC.code, USDC.issuer as string),
        amount,
      })
    )
    .setTimeout(TIMEOUT_SECONDS)
  if (memo !== undefined) builder.addMemo(Memo.text(memo))

  const payload: SigningPayload = {
    family: 'stellar',
    xdr: builder.build().toXDR(),
    account,
  }
  assertSafe(payload, expectation)
  return payload
}

const DEFINITE_FAILURES: readonly SubmitFailure['reason'][] = [
  'under_dest_min',
  'no_trustline',
  'underfunded',
  'no_path',
  'expired',
  'offer_cross_self',
  'low_reserve',
  'offer_not_found',
]

/**
 * Only an answer that settles it counts as a failure. `rejected` with a hash failed in
 * a ledger; without one it covers `tx_bad_seq`, which is what a second send of a
 * payment that already landed gets, so it is not known to have failed.
 */
function isDefiniteFailure(failure: SubmitFailure): boolean {
  if (failure.reason === 'rejected') return failure.hash !== undefined
  return DEFINITE_FAILURES.includes(failure.reason)
}

function pending(hash: string): SubmitResult {
  return {
    ok: false,
    pending: true,
    error: `This payment was sent but is not confirmed yet, and it may still land. Do not send it again. Its transaction is ${hash}.`,
  }
}

async function submit(
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  if (signed.family !== 'stellar') return refuseUnsigned('That is not a Stellar transaction.')
  assertPayment(signed.signedXdr, expectation, refuser(NOT_SENT))

  // Taken from the bytes before sending, so every uncertain answer can name it.
  const hash = transactionHashOf(signed.signedXdr)
  let result: Awaited<ReturnType<typeof submitSignedSwap>>
  try {
    result = await submitSignedSwap(signed.signedXdr)
  } catch {
    return pending(hash)
  }
  if (result.ok) return { ok: true, hash: result.hash, explorerUrl: result.explorerUrl }
  if (!isDefiniteFailure(result)) return pending(hash)
  return { ok: false, error: failureMessage(result) }
}

export const stellarDeposit: DepositChain = {
  chain: 'stellar',
  usdcDecimals: USDC_DECIMALS,
  supportsMemo: true,
  isAccount: isPublicKey,
  isDepositAddress: isPublicKey,
  usdcBalance: async (account) => (await balanceOf(account, 'USDC')) ?? BigInt(0),
  build,
  assertSafe,
  submit,
}
