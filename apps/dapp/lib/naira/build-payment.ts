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

/**
 * The XLM payment that funds a naira payout.
 *
 * Like the anchor off-ramp payment, this is a transaction that pays somebody
 * other than the signer, so it is built alone and admitted by an assertion of
 * its own. The destination and amount come from the order the server created
 * and stored, never from the browser, and are checked again against the signed
 * bytes before submit.
 */

const TIMEOUT_SECONDS = 180

export type NairaCoin = 'xlm' | 'usdc'

export interface NairaExpectation {
  /** The order's deposit address, read from the stored order. */
  destination: string
  /** What is paid: native XLM, or the app's own USDC and no other. */
  coin: NairaCoin
  /** Display units of `coin`, exactly as the order asked for. */
  amount: string
}

function assetFor(coin: NairaCoin): Asset {
  return coin === 'usdc' ? new Asset(USDC.code, USDC.issuer as string) : Asset.native()
}

async function loadSequence(
  account: string,
  horizonUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${account}`, {
    headers: { Accept: 'application/json' },
  })
  if (res.status === 404) throw new Error('This account is not funded yet, so it cannot pay.')
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const body = (await res.json()) as { sequence?: string }
  if (body.sequence === undefined) throw new Error('Horizon returned no sequence number')
  return body.sequence
}

export async function buildNairaPayment(options: {
  account: string
  expectation: NairaExpectation
  horizonUrl?: string
  fetchImpl?: typeof fetch
}): Promise<{ xdr: string; networkPassphrase: string }> {
  const { account, expectation } = options
  if (!StrKey.isValidEd25519PublicKey(expectation.destination)) {
    throw new Error('the order named a destination that is not an account')
  }
  // Refused here rather than inside the SDK with a message about nothing.
  toBaseUnits(expectation.amount)

  const sequence = await loadSequence(
    account,
    options.horizonUrl ?? stellarNetwork.horizonUrl,
    options.fetchImpl ?? fetch
  )

  const tx = new TransactionBuilder(new Account(account, sequence), {
    fee: BASE_FEE,
    networkPassphrase: stellarNetwork.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: expectation.destination,
        asset: assetFor(expectation.coin),
        amount: expectation.amount,
      })
    )
    .setTimeout(TIMEOUT_SECONDS)
    .build()

  const xdr = tx.toXDR()
  assertNairaPayment(xdr, account, expectation)
  return { xdr, networkPassphrase: stellarNetwork.networkPassphrase }
}

function refuse(field: string, detail: string): never {
  throw new Error(`refusing to sign naira payout: ${field} — ${detail}`)
}

interface DecodedPayment {
  type: string
  destination?: string
  amount?: string
  asset?: Asset
  source?: string
}

/** Admits a payment only when every field is the order's, read back from the XDR. */
export function assertNairaPayment(
  xdr: string,
  account: string,
  expectation: NairaExpectation
): void {
  const decoded = TransactionBuilder.fromXDR(xdr, stellarNetwork.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction) {
    refuse('shape', 'fee-bump transactions are not built here')
  }
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
    refuse('destination', `${op.destination ?? 'none'} is not the order's deposit address`)
  }
  if (expectation.coin === 'xlm') {
    if (op.asset === undefined || !op.asset.isNative()) {
      refuse('asset', 'this payout is funded in native XLM')
    }
  } else {
    // USDC is admitted only as the app's own: code and issuer both, because a
    // look-alike asset with the same code is a payment the provider never sees.
    if (
      op.asset === undefined ||
      op.asset.isNative() ||
      op.asset.code !== USDC.code ||
      op.asset.issuer !== USDC.issuer
    ) {
      refuse('asset', 'this payout is funded in the app’s USDC and no other asset')
    }
  }

  // Compared in stroops: '6' and '6.0000000' are one amount.
  if (
    op.amount === undefined ||
    BigInt(toBaseUnits(op.amount)) !== BigInt(toBaseUnits(expectation.amount))
  ) {
    refuse('amount', `${op.amount ?? 'none'} is not the ${expectation.amount} the order asked for`)
  }
}
