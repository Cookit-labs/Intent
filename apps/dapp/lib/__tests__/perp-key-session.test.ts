import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { KEY_CHALLENGE_NAME } from '../perps/key-challenge'
import { beginKeySession, completeKeySession } from '../perps/key-session'
import type { NoetherClient } from '../perps/noether-client'
import { NoetherHttpError, NoetherOfflineError } from '../perps/noether-client'

/**
 * Minting a Noether API key for the connected wallet, in two halves around
 * the wallet prompt.
 *
 * The gateway gates issuance behind a closed-beta allowlist, and says so
 * publicly through `beta-status`. That is asked first, so a wallet outside
 * the beta is told before it is asked to sign anything — the same reason the
 * offramp refuses MoneyGram before the SEP-10 prompt.
 */

const user = Keypair.random()
const ACCOUNT = user.publicKey()
const CHALLENGE = 'ab'.repeat(32)

function client(over: Partial<NoetherClient> = {}): NoetherClient {
  return {
    readHealth: async () => ({
      version: '0.0.0-dev',
      network: 'testnet',
      contracts: { market: 'CM', router: 'CR', vault: 'CV', usdcToken: 'CU' },
      paused: false,
    }),
    readMarkets: async () => [],
    readStats: async () => [],
    readVaults: async () => [],
    betaStatus: async () => ({ gated: true, allowed: true }),
    requestChallenge: async () => ({ challengeHex: CHALLENGE, expiresAt: 1790168326354 }),
    exchangeChallenge: async () => ({ keyId: 'nk_1', secret: 's3' }),
    prepareOpen: async () => ({ op: '', trader: '', xdr: '' }),
    submit: async () => ({ hash: '', status: 'FAILED' }),
    ...over,
  }
}

describe('beginKeySession', () => {
  it('returns a verifiable challenge for an allowed wallet', async () => {
    const out = await beginKeySession({ client: client(), account: ACCOUNT })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.challengeHex).toBe(CHALLENGE)
    expect(out.expiresAt).toBe(1790168326354)
    const tx = TransactionBuilder.fromXDR(out.xdr, Networks.TESTNET) as {
      sequence: string
      operations: { name?: string; source?: string }[]
    }
    expect(tx.sequence).toBe('0')
    expect(tx.operations[0]?.name).toBe(KEY_CHALLENGE_NAME)
    expect(tx.operations[0]?.source).toBe(ACCOUNT)
  })

  it('refuses a wallet outside the closed beta before any prompt', async () => {
    let challenged = false
    const out = await beginKeySession({
      client: client({
        betaStatus: async () => ({ gated: true, allowed: false }),
        requestChallenge: async () => {
          challenged = true
          return { challengeHex: CHALLENGE, expiresAt: 0 }
        },
      }),
      account: ACCOUNT,
    })
    expect(out).toEqual({
      ok: false,
      code: 'not_in_beta',
      error: expect.stringMatching(/closed beta/i),
    })
    expect(challenged).toBe(false)
  })

  it('proceeds when issuance is not gated at all', async () => {
    const out = await beginKeySession({
      client: client({ betaStatus: async () => ({ gated: false, allowed: false }) }),
      account: ACCOUNT,
    })
    expect(out.ok).toBe(true)
  })

  it('reports the venue offline when the gateway does not answer', async () => {
    const out = await beginKeySession({
      client: client({
        betaStatus: async () => {
          throw new NoetherOfflineError('no answer')
        },
      }),
      account: ACCOUNT,
    })
    expect(out).toEqual({ ok: false, code: 'offline', error: expect.stringMatching(/no answer/) })
  })
})

describe('completeKeySession', () => {
  async function signedChallenge(): Promise<string> {
    const begun = await beginKeySession({ client: client(), account: ACCOUNT })
    if (!begun.ok) throw new Error('begin failed')
    const tx = TransactionBuilder.fromXDR(begun.xdr, Networks.TESTNET)
    tx.sign(user)
    return tx.toXDR()
  }

  it('exchanges the signed challenge for a key', async () => {
    const seen: unknown[] = []
    const signed = await signedChallenge()
    const out = await completeKeySession({
      client: client({
        exchangeChallenge: async (input) => {
          seen.push(input)
          return { keyId: 'nk_1', secret: 's3' }
        },
      }),
      account: ACCOUNT,
      challengeHex: CHALLENGE,
      signedXdr: signed,
    })
    expect(out).toEqual({ ok: true, key: { keyId: 'nk_1', secret: 's3' } })
    expect(seen).toEqual([{ address: ACCOUNT, challengeHex: CHALLENGE, signedXdr: signed }])
  })

  it('re-verifies the signed envelope before forwarding it', async () => {
    // The XDR came back through the browser. A challenge that no longer
    // matches what was issued is refused here, whatever the gateway would say.
    const signed = await signedChallenge()
    const out = await completeKeySession({
      client: client(),
      account: ACCOUNT,
      challengeHex: 'cd'.repeat(32),
      signedXdr: signed,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/challenge/)
  })

  it('refuses an envelope the wallet did not sign', async () => {
    const begun = await beginKeySession({ client: client(), account: ACCOUNT })
    if (!begun.ok) throw new Error('begin failed')
    const out = await completeKeySession({
      client: client(),
      account: ACCOUNT,
      challengeHex: CHALLENGE,
      signedXdr: begun.xdr,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/signature/)
  })

  it('names the gateway refusal', async () => {
    const signed = await signedChallenge()
    const out = await completeKeySession({
      client: client({
        exchangeChallenge: async () => {
          throw new NoetherHttpError(403, "Noether's gateway refused: closed beta", 'not_in_beta')
        },
      }),
      account: ACCOUNT,
      challengeHex: CHALLENGE,
      signedXdr: signed,
    })
    expect(out).toEqual({
      ok: false,
      code: 'not_in_beta',
      error: expect.stringMatching(/closed beta/),
    })
  })
})
