import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { KEY_CHALLENGE_NAME, buildKeyChallenge, verifyKeyChallenge } from '../perps/key-challenge'

/**
 * The transaction a wallet signs to be issued a Noether API key.
 *
 * Same discipline as the SEP-10 verifier: what makes this safe to sign is
 * that it cannot be submitted, and every property that guarantees that is
 * checked before the wallet is asked. The gateway's own verifier (its
 * `walletAuth.ts`, read 2026-09-23) checks only that op[0] is a manageData
 * carrying the challenge and that a signature matches the address — so the
 * unsubmittability is this app's responsibility, not the gateway's.
 */

const user = Keypair.random()
const CHALLENGE = 'ab'.repeat(32)
const EXPECT = {
  address: user.publicKey(),
  challengeHex: CHALLENGE,
  networkPassphrase: Networks.TESTNET,
}

describe('buildKeyChallenge', () => {
  it('wraps the challenge bytes in a manageData op sourced by the user', () => {
    const xdr = buildKeyChallenge(EXPECT)
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
    expect('operations' in tx).toBe(true)
    const op = (tx as { operations: unknown[] }).operations[0] as {
      type: string
      name: string
      value: Uint8Array
      source?: string
    }
    expect(op.type).toBe('manageData')
    expect(op.name).toBe(KEY_CHALLENGE_NAME)
    expect(Buffer.from(op.value).toString('hex')).toBe(CHALLENGE)
    expect(op.source).toBe(user.publicKey())
  })

  it('is unsubmittable: sequence zero, sourced by a throwaway key', () => {
    const tx = TransactionBuilder.fromXDR(buildKeyChallenge(EXPECT), Networks.TESTNET) as {
      sequence: string
      source: string
    }
    expect(tx.sequence).toBe('0')
    expect(tx.source).not.toBe(user.publicKey())
  })

  it('verifies its own output', () => {
    expect(() => verifyKeyChallenge(buildKeyChallenge(EXPECT), EXPECT)).not.toThrow()
  })
})

/** A challenge built by hand, so each property can be broken on its own. */
function forged(
  t: {
    sequence?: string
    source?: string
    opSource?: string
    name?: string
    value?: Buffer
    extraOp?: boolean
    payment?: boolean
  } = {}
): string {
  const b = new TransactionBuilder(
    new Account(t.source ?? Keypair.random().publicKey(), t.sequence ?? '-1'),
    { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
  )
  if (t.payment === true) {
    b.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
        source: user.publicKey(),
      })
    )
  } else {
    b.addOperation(
      Operation.manageData({
        name: t.name ?? KEY_CHALLENGE_NAME,
        value: t.value ?? Buffer.from(CHALLENGE, 'hex'),
        source: t.opSource ?? user.publicKey(),
      })
    )
  }
  if (t.extraOp === true) {
    b.addOperation(
      Operation.payment({ destination: user.publicKey(), asset: Asset.native(), amount: '1' })
    )
  }
  return b.setTimeout(0).build().toXDR()
}

describe('verifyKeyChallenge', () => {
  it('accepts a well-formed challenge', () => {
    expect(() => verifyKeyChallenge(forged(), EXPECT)).not.toThrow()
  })

  it('refuses a sequence that could be submitted', () => {
    expect(() => verifyKeyChallenge(forged({ sequence: '41' }), EXPECT)).toThrow(/sequence/)
  })

  it('refuses a transaction sourced by the user', () => {
    // Sequence zero already makes it unsubmittable; this is the second lock.
    // A wallet signature over a transaction the user sources is the shape of
    // an authorisation, and no challenge needs to look like one.
    expect(() => verifyKeyChallenge(forged({ source: user.publicKey() }), EXPECT)).toThrow(/source/)
  })

  it('refuses an operation sourced by somebody else', () => {
    expect(() =>
      verifyKeyChallenge(forged({ opSource: Keypair.random().publicKey() }), EXPECT)
    ).toThrow(/sourced/)
  })

  it('refuses a challenge value that is not the one issued', () => {
    expect(() =>
      verifyKeyChallenge(forged({ value: Buffer.from('cd'.repeat(32), 'hex') }), EXPECT)
    ).toThrow(/challenge/)
  })

  it('refuses a data name other than the gateway’s', () => {
    expect(() => verifyKeyChallenge(forged({ name: 'other auth' }), EXPECT)).toThrow(/named/)
  })

  it('refuses a second operation', () => {
    expect(() => verifyKeyChallenge(forged({ extraOp: true }), EXPECT)).toThrow(/one operation/)
  })

  it('refuses anything that is not manageData', () => {
    expect(() => verifyKeyChallenge(forged({ payment: true }), EXPECT)).toThrow(/manageData/)
  })

  it('refuses a fee bump', () => {
    const inner = TransactionBuilder.fromXDR(forged(), Networks.TESTNET)
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200',
      inner as import('@stellar/stellar-sdk').Transaction,
      Networks.TESTNET
    )
    expect(() => verifyKeyChallenge(bump.toXDR(), EXPECT)).toThrow(/fee bump/)
  })
})
