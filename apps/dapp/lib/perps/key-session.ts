import { stellarNetwork } from '@intent/config'
import { Keypair } from '@stellar/stellar-sdk'

import { buildKeyChallenge, verifyKeyChallenge } from './key-challenge'
import type { NoetherClient, NoetherKey } from './noether-client'
import { NoetherHttpError, NoetherOfflineError } from './noether-client'

/**
 * Minting a Noether API key for the connected wallet.
 *
 * Two halves around the wallet prompt, because the prompt happens in the
 * browser and the gateway is spoken to from the server: `begin` asks whether
 * this wallet may have a key at all, fetches the challenge and wraps it;
 * the browser verifies and signs; `complete` verifies the signed copy again
 * and exchanges it.
 *
 * The beta check comes first, before anything is built. Noether gates key
 * issuance behind a closed-beta allowlist and says so through a public
 * endpoint (`beta-status` answered `gated: true, allowed: false` for every
 * address tried on 2026-09-23). A wallet outside it is told here, not after
 * signing a challenge for a key it will never be given.
 */

export type KeySessionFailure = {
  ok: false
  code: 'not_in_beta' | 'offline' | 'refused' | string
  error: string
}

export type BeginKeySessionResult =
  | { ok: true; xdr: string; challengeHex: string; expiresAt: number }
  | KeySessionFailure

function failure(e: unknown): KeySessionFailure {
  if (e instanceof NoetherOfflineError) return { ok: false, code: 'offline', error: e.message }
  if (e instanceof NoetherHttpError) {
    return { ok: false, code: e.code ?? 'gateway', error: e.message }
  }
  return { ok: false, code: 'refused', error: e instanceof Error ? e.message : String(e) }
}

export async function beginKeySession(options: {
  client: NoetherClient
  account: string
}): Promise<BeginKeySessionResult> {
  const { client, account } = options
  try {
    const beta = await client.betaStatus(account)
    if (beta.gated && !beta.allowed) {
      return {
        ok: false,
        code: 'not_in_beta',
        error:
          'Noether issues API keys only to wallets in its closed beta, and this wallet is not on the list. Nothing was signed.',
      }
    }
    const challenge = await client.requestChallenge(account)
    const xdr = buildKeyChallenge({
      address: account,
      challengeHex: challenge.challengeHex,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
    return { ok: true, xdr, challengeHex: challenge.challengeHex, expiresAt: challenge.expiresAt }
  } catch (e) {
    return failure(e)
  }
}

export type CompleteKeySessionResult = { ok: true; key: NoetherKey } | KeySessionFailure

export async function completeKeySession(options: {
  client: NoetherClient
  account: string
  challengeHex: string
  signedXdr: string
}): Promise<CompleteKeySessionResult> {
  const { client, account, challengeHex, signedXdr } = options

  // Verified again on the way back. The envelope crossed the browser and a
  // wallet extension; what is forwarded is what these bytes say, not what
  // was built.
  let tx
  try {
    tx = verifyKeyChallenge(signedXdr, {
      address: account,
      challengeHex,
      networkPassphrase: stellarNetwork.networkPassphrase,
    })
  } catch (e) {
    return failure(e)
  }

  // The gateway checks this too. It is checked here so an unsigned envelope
  // — a wallet that returned the input untouched — is named as such rather
  // than surfacing as a bare 401 from the gateway.
  const signer = Keypair.fromPublicKey(account)
  const hash = tx.hash()
  const signed = tx.signatures.some((sig) => {
    const s = sig as unknown as { signature: { value: Uint8Array } }
    try {
      return signer.verify(hash, Buffer.from(s.signature.value))
    } catch {
      return false
    }
  })
  if (!signed) {
    return {
      ok: false,
      code: 'refused',
      error: 'the challenge carries no signature by this wallet',
    }
  }

  try {
    const key = await client.exchangeChallenge({ address: account, challengeHex, signedXdr })
    return { ok: true, key }
  } catch (e) {
    return failure(e)
  }
}
