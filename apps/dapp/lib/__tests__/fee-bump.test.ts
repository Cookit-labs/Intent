import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { sponsorFee } from '../sponsor/fee-bump'

/**
 * The app pays the network fee so a user holding only USDC can still trade.
 *
 * Stellar's fee-bump wraps an already-signed transaction in an outer envelope
 * signed by a different account, which pays the fee. The user's signature
 * stays on the inner transaction untouched; the sponsor never sees the key
 * and never signs the operations. What the sponsor does need is protection
 * from a crafted inner fee, and a refusal to bump anything it did not build
 * for.
 */

const user = Keypair.random()
const sponsor = Keypair.random()
const other = Keypair.random()

function inner(opts: { fee?: string; signer?: Keypair; ops?: number } = {}): string {
  const builder = new TransactionBuilder(new Account(user.publicKey(), '1'), {
    fee: opts.fee ?? BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  for (let i = 0; i < (opts.ops ?? 1); i += 1) {
    builder.addOperation(
      Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: '1' })
    )
  }
  const tx = builder.setTimeout(60).build()
  if (opts.signer !== null) tx.sign(opts.signer ?? user)
  return tx.toXDR()
}

function unsigned(): string {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: '1' })
    )
    .setTimeout(60)
    .build()
  return tx.toXDR()
}

describe('sponsorFee', () => {
  it('wraps a signed transaction so the sponsor pays and the user still authorises', () => {
    const out = sponsorFee(inner(), user.publicKey(), { sponsor, passphrase: Networks.TESTNET })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const bumped = TransactionBuilder.fromXDR(out.xdr, Networks.TESTNET)
    expect(bumped).toBeInstanceOf(FeeBumpTransaction)
    const fb = bumped as FeeBumpTransaction
    expect(fb.feeSource).toBe(sponsor.publicKey())
    // The inner transaction is the user's, byte for byte: same hash, same signature.
    expect(Buffer.from(fb.innerTransaction.hash()).toString('hex')).toBe(
      Buffer.from(TransactionBuilder.fromXDR(inner(), Networks.TESTNET).hash()).toString('hex')
    )
    expect(fb.innerTransaction.signatures).toHaveLength(1)
    // One sponsor signature on the outer envelope, and nothing else.
    expect(fb.signatures).toHaveLength(1)
  })

  it('charges the outer envelope one more operation than the inner one', () => {
    // Stellar counts the bump itself as an operation for fee purposes.
    const out = sponsorFee(inner({ ops: 3 }), user.publicKey(), {
      sponsor,
      passphrase: Networks.TESTNET,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.feeStroops).toBe(String(Number(BASE_FEE) * 4))
  })

  it('never bumps below the inner fee, which Soroban transactions raise', () => {
    // A contract call's inner fee includes its resource fee, far above the
    // base fee. The outer fee must cover it or the network rejects the bump.
    const out = sponsorFee(inner({ fee: '250000' }), user.publicKey(), {
      sponsor,
      passphrase: Networks.TESTNET,
      maxFeeStroops: BigInt('10000000'),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(BigInt(out.feeStroops)).toBeGreaterThanOrEqual(BigInt('250000'))
  })

  it('refuses an inner transaction the user has not signed', () => {
    // The sponsor pays fees; it does not lend authority. An unsigned inner
    // transaction would fail on submission anyway, but refusing it here keeps
    // the sponsor from ever putting its signature beside nothing.
    const out = sponsorFee(unsigned(), user.publicKey(), { sponsor, passphrase: Networks.TESTNET })
    expect(out).toEqual({ ok: false, reason: 'not_signed_by_account' })
  })

  it('refuses a transaction signed by someone other than the named account', () => {
    const out = sponsorFee(inner({ signer: other }), user.publicKey(), {
      sponsor,
      passphrase: Networks.TESTNET,
    })
    expect(out).toEqual({ ok: false, reason: 'not_signed_by_account' })
  })

  it('refuses a transaction from a different source account', () => {
    const out = sponsorFee(inner(), other.publicKey(), { sponsor, passphrase: Networks.TESTNET })
    expect(out).toEqual({ ok: false, reason: 'source_mismatch' })
  })

  it('refuses to bump a transaction that is already a fee bump', () => {
    const first = sponsorFee(inner(), user.publicKey(), { sponsor, passphrase: Networks.TESTNET })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = sponsorFee(first.xdr, user.publicKey(), { sponsor, passphrase: Networks.TESTNET })
    expect(again).toEqual({ ok: false, reason: 'already_bumped' })
  })

  it('refuses an inner fee that would cost the sponsor more than it allows', () => {
    // A crafted inner transaction with an enormous fee would otherwise drain
    // the sponsor one submission at a time.
    const out = sponsorFee(inner({ fee: '50000000' }), user.publicKey(), {
      sponsor,
      passphrase: Networks.TESTNET,
      maxFeeStroops: BigInt('1000000'),
    })
    expect(out).toEqual({ ok: false, reason: 'fee_over_cap' })
  })
})
