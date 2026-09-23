import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'

/**
 * The transaction a wallet signs to be issued a Noether API key.
 *
 * Noether's gateway hands out 32 random bytes and expects them back inside a
 * signed transaction: op[0] a `manageData` whose value is the bytes, with any
 * signature over the transaction hash matching the address (its
 * `walletAuth.ts`, read 2026-09-23). It does that, rather than a signed
 * message, because browser wallets expose `signTransaction` and rarely
 * `signMessage` — the same reason SEP-10 is shaped the way it is.
 *
 * The gateway's verifier checks nothing else. In particular it does not check
 * that the transaction is unsubmittable, so that is this app's job, and it is
 * done here before the wallet is ever asked: sequence zero, a throwaway
 * source, one operation, and that operation a `manageData`. Mirrors
 * `offramp/sep10.ts`, minus the anchor's signature (the gateway signs
 * nothing) and plus the check that the throwaway source is not the user.
 */

/** The data name the SDK uses; the gateway reads the value, not the name. */
export const KEY_CHALLENGE_NAME = 'noether-api auth'

export interface KeyChallengeExpectation {
  /** The wallet that will sign. */
  address: string
  /** The bytes the gateway issued, hex. */
  challengeHex: string
  networkPassphrase: string
}

export function buildKeyChallenge(expect: KeyChallengeExpectation): string {
  if (!/^[0-9a-f]{64}$/i.test(expect.challengeHex)) {
    throw new Error('the challenge is not 32 hex bytes')
  }
  // A random source with sequence 0 mirrors the SDK. Sequence 0 means no
  // account on the network can ever have it as its next sequence, and a
  // random source means even a future protocol change could not bind it to
  // the user.
  const placeholder = Keypair.random().publicKey()
  const tx = new TransactionBuilder(new Account(placeholder, '-1'), {
    fee: '0',
    networkPassphrase: expect.networkPassphrase,
  })
    .addOperation(
      Operation.manageData({
        name: KEY_CHALLENGE_NAME,
        value: Buffer.from(expect.challengeHex, 'hex'),
        source: expect.address,
      })
    )
    .setTimeout(0)
    .build()
  return tx.toXDR()
}

function refuse(check: string, detail: string): never {
  throw new Error(`refusing key challenge: ${check} — ${detail}`)
}

interface DecodedManageData {
  type: string
  name?: string
  value?: Uint8Array | null
  source?: string
}

export function verifyKeyChallenge(xdr: string, expect: KeyChallengeExpectation): Transaction {
  const decoded = TransactionBuilder.fromXDR(xdr, expect.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction) refuse('shape', 'a fee bump is not a challenge')
  const tx = decoded

  if (tx.sequence !== '0') {
    refuse('sequence', `${tx.sequence} could be submitted; a challenge must be 0`)
  }
  if (tx.source === expect.address) {
    refuse('source', 'the challenge must not be sourced by the signing account')
  }

  if (tx.operations.length !== 1) {
    refuse('operations', `exactly one operation is expected, found ${tx.operations.length}`)
  }
  const op = tx.operations[0] as unknown as DecodedManageData
  if (op.type !== 'manageData') refuse('operation', `${op.type} is not manageData`)
  if (op.source !== expect.address) {
    refuse('operation', `sourced by ${op.source ?? 'nobody'}, not the signing account`)
  }
  if (op.name !== KEY_CHALLENGE_NAME) {
    refuse('operation', `named "${op.name ?? ''}", expected "${KEY_CHALLENGE_NAME}"`)
  }
  const value =
    op.value === null || op.value === undefined ? '' : Buffer.from(op.value).toString('hex')
  if (value.toLowerCase() !== expect.challengeHex.toLowerCase()) {
    refuse('challenge', 'the value is not the challenge the gateway issued')
  }

  return tx
}
