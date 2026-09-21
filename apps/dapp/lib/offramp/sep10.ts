import { FeeBumpTransaction, Keypair, TransactionBuilder } from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'

/**
 * SEP-10: proving to an anchor that the user controls their account.
 *
 * The anchor sends a transaction; the wallet signs it; the anchor returns a
 * JWT. What makes this safe to sign is that the transaction is unsubmittable
 * by construction — sequence number zero, sourced by the anchor, containing
 * only `manageData` — and every one of those properties is checked here
 * before the wallet is asked. The anchor's signature is verified against the
 * key pinned in `anchors.ts`, not against anything the network said: an
 * attacker who can answer the challenge request could otherwise present any
 * transaction at all and have it signed.
 *
 * Hand-rolled because the official wallet SDK's client signer is synchronous
 * and requires a local secret, and Freighter is neither. The whole exchange
 * is one GET, one signature, one POST.
 *
 * Shapes below were verified against the installed SDK build: decoded
 * `manageData` values are `Uint8Array`; `tx.sequence` is a string; signatures
 * expose `.hint.value` and `.signature.value` as `Uint8Array`.
 */

export interface ChallengeExpectation {
  /** The anchor's pinned signing key. */
  serverKey: string
  /** The account being authenticated — the wallet that will sign. */
  clientAccount: string
  /** The anchor's home domain; the first operation is named `<domain> auth`. */
  homeDomain: string
  /** The host of the auth endpoint, which the challenge must name. */
  webAuthDomain: string
  networkPassphrase: string
  /** Injected in tests. */
  nowSeconds?: number
}

function refuse(check: string, detail: string): never {
  throw new Error(`refusing challenge: ${check} — ${detail}`)
}

function text(value: Uint8Array | null | undefined): string {
  return value === null || value === undefined ? '' : new TextDecoder().decode(value)
}

interface DecodedManageData {
  type: string
  name?: string
  value?: Uint8Array | null
  source?: string
}

export function verifyChallenge(xdr: string, expect: ChallengeExpectation): Transaction {
  const decoded = TransactionBuilder.fromXDR(xdr, expect.networkPassphrase)
  if (decoded instanceof FeeBumpTransaction) refuse('shape', 'a fee bump is not a challenge')
  const tx = decoded

  if (tx.source !== expect.serverKey) {
    refuse('source', `${tx.source} is not the anchor's pinned key`)
  }

  if (tx.sequence !== '0') {
    refuse('sequence', `${tx.sequence} could be submitted; a challenge must be 0`)
  }

  const now = expect.nowSeconds ?? Math.floor(Date.now() / 1000)
  const bounds = tx.timeBounds
  if (bounds === undefined) refuse('time bounds', 'none set')
  const min = Number(bounds.minTime)
  const max = Number(bounds.maxTime)
  if (!(min <= now && now <= max)) {
    refuse('time bounds', `now ${now} is outside ${min}..${max}`)
  }

  const ops = tx.operations as unknown as DecodedManageData[]
  if (ops.length === 0) refuse('operations', 'none')

  ops.forEach((op, i) => {
    if (op.type !== 'manageData') {
      refuse(`operation ${i + 1}`, `${op.type} is not manageData`)
    }
  })

  const first = ops[0] as DecodedManageData
  if (first.source !== expect.clientAccount) {
    refuse('first operation', `sourced by ${first.source ?? 'nobody'}, not the signing account`)
  }
  if (first.name !== `${expect.homeDomain} auth`) {
    refuse('first operation', `named "${first.name ?? ''}", expected "${expect.homeDomain} auth"`)
  }

  const domainOp = ops.find((op) => op.name === 'web_auth_domain')
  if (domainOp === undefined) refuse('web_auth_domain', 'absent')
  if (text(domainOp.value) !== expect.webAuthDomain) {
    refuse('web_auth_domain', `names ${text(domainOp.value)}, expected ${expect.webAuthDomain}`)
  }
  if (domainOp.source !== expect.serverKey) {
    refuse('web_auth_domain', 'not sourced by the anchor')
  }

  const server = Keypair.fromPublicKey(expect.serverKey)
  const hint = Buffer.from(server.signatureHint())
  const hash = tx.hash()
  const signed = tx.signatures.some((sig) => {
    const s = sig as unknown as { hint: { value: Uint8Array }; signature: { value: Uint8Array } }
    if (!Buffer.from(s.hint.value).equals(hint)) return false
    return server.verify(hash, Buffer.from(s.signature.value))
  })
  if (!signed) refuse('signature', 'not signed by the pinned anchor key')

  return tx
}
