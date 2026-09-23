import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk'

/**
 * The app pays the network fee, so a user holding only USDC can still trade.
 *
 * Stellar's fee-bump wraps an already-signed transaction in an outer envelope
 * signed by a different account, which pays the fee. The inner transaction is
 * untouched: same operations, same sequence number, the user's own signature
 * still on it. The sponsor never sees the user's key and never authorises an
 * operation; it only pays.
 *
 * What the sponsor needs is protection from a crafted inner transaction. An
 * inner fee is set by whoever built the envelope, and a fee-bump has to cover
 * it, so without a cap one submission could name a fee that empties the
 * sponsor. And a bump is only ever for the account the app built for: an
 * envelope signed by someone else, or from a different source, is not this
 * app's to pay for.
 */

export interface SponsorOptions {
  sponsor: Keypair
  passphrase: string
  /**
   * The most the sponsor will pay for one transaction, in stroops.
   *
   * One XLM by default. A classic transaction costs a few hundred stroops; a
   * Soroban call's resource fee runs to a fraction of an XLM. Anything above
   * that is not a fee, it is a request.
   */
  maxFeeStroops?: bigint
}

export type SponsorOutcome =
  | { ok: true; xdr: string; feeStroops: string }
  | {
      ok: false
      reason:
        | 'unreadable'
        | 'already_bumped'
        | 'source_mismatch'
        | 'not_signed_by_account'
        | 'fee_over_cap'
    }

const DEFAULT_MAX_FEE_STROOPS = BigInt(10_000_000)

/** Whether any signature on the transaction is the named account's. */
function signedBy(tx: Transaction, account: string): boolean {
  const key = Keypair.fromPublicKey(account)
  const hint = Buffer.from(key.signatureHint())
  const hash = Buffer.from(tx.hash())
  return tx.signatures.some((sig) => {
    // The SDK wraps the hint and signature bytes in typed values; `.value`
    // is the bytes.
    const sigHint = Buffer.from((sig.hint as unknown as { value: Uint8Array }).value)
    const bytes = Buffer.from((sig.signature as unknown as { value: Uint8Array }).value)
    return sigHint.equals(hint) && key.verify(hash, bytes)
  })
}

export function sponsorFee(
  innerXdr: string,
  account: string,
  options: SponsorOptions
): SponsorOutcome {
  let parsed
  try {
    parsed = TransactionBuilder.fromXDR(innerXdr, options.passphrase)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (parsed instanceof FeeBumpTransaction) return { ok: false, reason: 'already_bumped' }
  const inner = parsed

  if (inner.source !== account) return { ok: false, reason: 'source_mismatch' }
  if (!signedBy(inner, account)) return { ok: false, reason: 'not_signed_by_account' }

  // The outer fee is per operation, and the bump itself counts as one. It
  // must cover the inner fee in full — a Soroban inner fee carries the
  // resource fee, well above the base — so the per-operation figure is the
  // inner total spread over the inner operations, floored at the base fee.
  const ops = BigInt(Math.max(1, inner.operations.length))
  const innerTotal = BigInt(inner.fee)
  const base = BigInt(BASE_FEE)
  const perOp = innerTotal / ops + (innerTotal % ops === BigInt(0) ? BigInt(0) : BigInt(1))
  const perOpFee = perOp > base ? perOp : base
  const outerTotal = perOpFee * (ops + BigInt(1))

  const cap = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS
  if (outerTotal > cap) return { ok: false, reason: 'fee_over_cap' }

  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    options.sponsor.publicKey(),
    perOpFee.toString(),
    inner,
    options.passphrase
  )
  bumped.sign(options.sponsor)

  return { ok: true, xdr: bumped.toXDR(), feeStroops: bumped.fee }
}
