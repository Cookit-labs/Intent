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

import { sponsorConfigured, sponsorForSubmission } from '../sponsor/sponsor'

/**
 * The server-side half: whether a sponsor is configured, whether its account
 * exists yet, and what to do when a bump cannot be made. The rule for the
 * last case is that the user's transaction still goes out, paying its own
 * fee, exactly as it did before sponsorship existed. Sponsorship removes a
 * cost; it must never add a failure.
 */

const user = Keypair.random()
const sponsor = Keypair.random()

function signedByUser(): string {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: '1' })
    )
    .setTimeout(60)
    .build()
  tx.sign(user)
  return tx.toXDR()
}

/** Horizon that knows the sponsor account, or says it does not exist. */
function horizon(known: boolean, calls: string[]): typeof fetch {
  return ((url: string) => {
    calls.push(url)
    if (url.includes('friendbot')) return Promise.resolve(new Response('{}', { status: 200 }))
    if (url.includes('/accounts/')) {
      return Promise.resolve(
        new Response(known ? JSON.stringify({ sequence: '1' }) : '{}', {
          status: known ? 200 : 404,
        })
      )
    }
    return Promise.resolve(new Response('{}', { status: 500 }))
  }) as unknown as typeof fetch
}

describe('sponsorConfigured', () => {
  it('is false with no key, or an empty one', () => {
    expect(sponsorConfigured({})).toBe(false)
    expect(sponsorConfigured({ SPONSOR_SECRET_KEY: '' })).toBe(false)
  })

  it('is true with a secret key', () => {
    expect(sponsorConfigured({ SPONSOR_SECRET_KEY: sponsor.secret() })).toBe(true)
  })
})

describe('sponsorForSubmission', () => {
  it('passes the transaction through untouched when no sponsor is configured', async () => {
    const xdr = signedByUser()
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      env: {},
      fetchImpl: horizon(true, []),
    })
    expect(out).toEqual({ xdr, sponsored: false })
  })

  it('wraps the transaction when the sponsor is configured and funded', async () => {
    const calls: string[] = []
    const out = await sponsorForSubmission(signedByUser(), user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
      fetchImpl: horizon(true, calls),
    })
    expect(out.sponsored).toBe(true)
    const tx = TransactionBuilder.fromXDR(out.xdr, Networks.TESTNET)
    expect(tx).toBeInstanceOf(FeeBumpTransaction)
    expect((tx as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey())
    expect(calls.some((u) => u.includes('friendbot'))).toBe(false)
  })

  it('funds the sponsor from friendbot first when its account does not exist yet', async () => {
    // Testnet only, and only ever for the sponsor's own account. A fresh
    // deployment should not need a hand-funded key to start paying fees.
    const calls: string[] = []
    const out = await sponsorForSubmission(signedByUser(), user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
      fetchImpl: horizon(false, calls),
    })
    expect(out.sponsored).toBe(true)
    expect(calls.some((u) => u.includes('friendbot') && u.includes(sponsor.publicKey()))).toBe(true)
  })

  it('falls back to the unsponsored transaction when a bump cannot be made', async () => {
    // Signed by nobody: the bump is refused, and the caller gets the original
    // bytes back with the reason, to submit as before.
    const unsigned = new TransactionBuilder(new Account(user.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: '1' })
      )
      .setTimeout(60)
      .build()
      .toXDR()
    const out = await sponsorForSubmission(unsigned, user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
      fetchImpl: horizon(true, []),
    })
    expect(out).toEqual({ xdr: unsigned, sponsored: false, reason: 'not_signed_by_account' })
  })

  it('falls back when the sponsor key is not a valid secret', async () => {
    const xdr = signedByUser()
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: 'not-a-key' },
      fetchImpl: horizon(true, []),
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'invalid_sponsor_key' })
  })
})
