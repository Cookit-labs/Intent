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

import { verifyChallenge } from '../offramp/sep10'

/**
 * Every SEP-10 check, each failing on its own.
 *
 * The challenge is a transaction the user's wallet is asked to sign. Its safety
 * rests on properties that make it unsubmittable — sequence zero above all —
 * and on the anchor's signature proving who built it. Each of those is a
 * separate check here, because a verifier that bundles them reports "invalid"
 * and a developer cannot tell which property an attacker's challenge lacked.
 */

const server = Keypair.random()
const client = Keypair.random()
const HOME = 'testanchor.stellar.org'
const NOW = 1_800_000_000

interface Tweak {
  source?: string
  sequence?: string
  minTime?: number
  maxTime?: number
  firstOpSource?: string
  firstOpName?: string
  webAuthDomain?: string
  webAuthDomainSource?: string
  omitWebAuthDomain?: boolean
  extraOp?: boolean
  signer?: Keypair
  unsigned?: boolean
  forgeSignature?: boolean
}

function challenge(t: Tweak = {}): string {
  const builder = new TransactionBuilder(
    new Account(t.source ?? server.publicKey(), t.sequence ?? '-1'),
    {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: t.minTime ?? NOW - 10, maxTime: t.maxTime ?? NOW + 900 },
    }
  ).addOperation(
    Operation.manageData({
      name: t.firstOpName ?? `${HOME} auth`,
      value: Buffer.alloc(48, 3).toString('base64'),
      source: t.firstOpSource ?? client.publicKey(),
    })
  )
  if (t.omitWebAuthDomain !== true) {
    builder.addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: t.webAuthDomain ?? HOME,
        source: t.webAuthDomainSource ?? server.publicKey(),
      })
    )
  }
  if (t.extraOp === true) {
    builder.addOperation(
      Operation.payment({ destination: server.publicKey(), asset: Asset.native(), amount: '1' })
    )
  }
  const tx = builder.build()
  if (t.unsigned !== true) tx.sign(t.signer ?? server)
  if (t.forgeSignature === true && tx.signatures.length > 0) {
    const sig = tx.signatures[0] as unknown as { signature: { value: Uint8Array } }
    sig.signature.value[0] = sig.signature.value[0]! ^ 0xff
  }
  return tx.toXDR()
}

const EXPECT = {
  serverKey: server.publicKey(),
  clientAccount: client.publicKey(),
  homeDomain: HOME,
  webAuthDomain: HOME,
  networkPassphrase: Networks.TESTNET,
  nowSeconds: NOW,
}

describe('verifyChallenge', () => {
  it('accepts a well-formed challenge', () => {
    const tx = verifyChallenge(challenge(), EXPECT)
    expect(tx.sequence).toBe('0')
  })

  it('refuses a challenge sourced by anyone but the anchor', () => {
    expect(() => verifyChallenge(challenge({ source: client.publicKey() }), EXPECT)).toThrow(
      /refusing challenge: source/
    )
  })

  it('refuses a challenge with a real sequence number', () => {
    // The property that makes signing safe: seq 0 can never be submitted.
    expect(() => verifyChallenge(challenge({ sequence: '41' }), EXPECT)).toThrow(
      /refusing challenge: sequence/
    )
  })

  it('refuses an expired challenge', () => {
    expect(() =>
      verifyChallenge(challenge({ minTime: NOW - 2000, maxTime: NOW - 1000 }), EXPECT)
    ).toThrow(/refusing challenge: time/)
  })

  it('refuses a challenge not yet valid', () => {
    expect(() =>
      verifyChallenge(challenge({ minTime: NOW + 100, maxTime: NOW + 900 }), EXPECT)
    ).toThrow(/refusing challenge: time/)
  })

  it('refuses a first operation sourced by another account', () => {
    expect(() =>
      verifyChallenge(challenge({ firstOpSource: Keypair.random().publicKey() }), EXPECT)
    ).toThrow(/refusing challenge: first operation/)
  })

  it('refuses a first operation named for another domain', () => {
    expect(() => verifyChallenge(challenge({ firstOpName: 'evil.example auth' }), EXPECT)).toThrow(
      /refusing challenge: first operation/
    )
  })

  it('refuses a web_auth_domain naming another host', () => {
    expect(() => verifyChallenge(challenge({ webAuthDomain: 'evil.example' }), EXPECT)).toThrow(
      /refusing challenge: web_auth_domain/
    )
  })

  it('refuses an operation that is not manageData', () => {
    expect(() => verifyChallenge(challenge({ extraOp: true }), EXPECT)).toThrow(
      /refusing challenge: operation 3/
    )
  })

  it('refuses a challenge the anchor did not sign', () => {
    expect(() => verifyChallenge(challenge({ unsigned: true }), EXPECT)).toThrow(
      /refusing challenge: signature/
    )
  })

  it('refuses a challenge signed by a key other than the pinned one', () => {
    // The man-in-the-middle case: right shape, wrong signer.
    expect(() => verifyChallenge(challenge({ signer: Keypair.random() }), EXPECT)).toThrow(
      /refusing challenge: signature/
    )
  })

  it('refuses a challenge for another network', () => {
    expect(() =>
      verifyChallenge(challenge(), { ...EXPECT, networkPassphrase: Networks.PUBLIC })
    ).toThrow(/refusing challenge: signature/)
  })

  it('refuses a signature that carries the anchor hint but does not verify', () => {
    // The case a hint-only check would let through: right 4-byte hint,
    // wrong 64-byte signature. Only a real verify() against the hash
    // rejects it.
    expect(() => verifyChallenge(challenge({ forgeSignature: true }), EXPECT)).toThrow(
      /refusing challenge: signature/
    )
  })

  it('refuses a web_auth_domain that is absent', () => {
    expect(() => verifyChallenge(challenge({ omitWebAuthDomain: true }), EXPECT)).toThrow(
      /refusing challenge: web_auth_domain/
    )
  })

  it('refuses a web_auth_domain sourced by someone other than the anchor', () => {
    expect(() =>
      verifyChallenge(challenge({ webAuthDomainSource: Keypair.random().publicKey() }), EXPECT)
    ).toThrow(/refusing challenge: web_auth_domain/)
  })
})
