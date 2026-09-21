import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { ANCHORS } from '../offramp/anchors'
import { authenticate, jwtExpiry } from '../offramp/sep10'
import type { AnchorToml } from '../offramp/toml'

/**
 * The exchange around the verifier: fetch, verify, sign, post, keep the token.
 *
 * The signer is injected because the real one is a browser extension. The
 * important property pinned here is order: the signer is never called with a
 * challenge that failed verification, because a wallet prompt for a bad
 * challenge is the attack.
 */

const server = Keypair.random()
const client = Keypair.random()
const NOW = 1_800_000_000

const anchor = { ...ANCHORS.testanchor, signingKey: server.publicKey() }
const toml: AnchorToml = {
  transferServerSep24: 'https://testanchor.stellar.org/sep24',
  webAuthEndpoint: 'https://testanchor.stellar.org/auth',
  signingKey: server.publicKey(),
  networkPassphrase: Networks.TESTNET,
}

function goodChallenge(): string {
  const tx = new TransactionBuilder(new Account(server.publicKey(), '-1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: NOW - 10, maxTime: NOW + 900 },
  })
    .addOperation(
      Operation.manageData({
        name: 'testanchor.stellar.org auth',
        value: Buffer.alloc(48, 1).toString('base64'),
        source: client.publicKey(),
      })
    )
    .addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: 'testanchor.stellar.org',
        source: server.publicKey(),
      })
    )
    .build()
  tx.sign(server)
  return tx.toXDR()
}

function jwt(exp: number): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ sub: client.publicKey(), exp })}.sig`
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function anchorServer(challengeXdr: string, token: string, calls: Call[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ token }), { status: 200 }))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ transaction: challengeXdr, network_passphrase: Networks.TESTNET }),
        { status: 200 }
      )
    )
  }) as unknown as typeof fetch
}

const localSigner = async (xdr: string): Promise<string> => {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
  tx.sign(client)
  return tx.toXDR()
}

describe('authenticate', () => {
  it('fetches, verifies, signs, posts and returns the token with its expiry', async () => {
    const calls: Call[] = []
    const session = await authenticate({
      anchor,
      toml,
      account: client.publicKey(),
      sign: localSigner,
      fetchImpl: anchorServer(goodChallenge(), jwt(NOW + 600), calls),
      nowSeconds: NOW,
    })
    expect(session.token).toMatch(/^eyJ/)
    expect(session.expiresAt).toBe(NOW + 600)
    expect(calls[0]?.url).toBe(`https://testanchor.stellar.org/auth?account=${client.publicKey()}`)
    expect(calls[1]?.init?.method).toBe('POST')
    const posted = JSON.parse(String(calls[1]?.init?.body)) as { transaction: string }
    // The posted envelope carries both signatures: the anchor's and ours.
    expect(
      TransactionBuilder.fromXDR(posted.transaction, Networks.TESTNET).signatures
    ).toHaveLength(2)
  })

  it('never asks the wallet to sign a challenge that fails verification', async () => {
    let signerCalled = false
    const spy = async (xdr: string): Promise<string> => {
      signerCalled = true
      return localSigner(xdr)
    }
    const forged = { ...anchor, signingKey: Keypair.random().publicKey() }
    await expect(
      authenticate({
        anchor: forged,
        toml: { ...toml, signingKey: forged.signingKey },
        account: client.publicKey(),
        sign: spy,
        fetchImpl: anchorServer(goodChallenge(), jwt(NOW + 600), []),
        nowSeconds: NOW,
      })
    ).rejects.toThrow(/refusing challenge/)
    expect(signerCalled).toBe(false)
  })

  it('refuses a challenge for another network before verifying', async () => {
    const wrongNet = ((url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(new Response('{}'))
        : Promise.resolve(
            new Response(
              JSON.stringify({ transaction: goodChallenge(), network_passphrase: Networks.PUBLIC })
            )
          )) as unknown as typeof fetch
    await expect(
      authenticate({
        anchor,
        toml,
        account: client.publicKey(),
        sign: localSigner,
        fetchImpl: wrongNet,
        nowSeconds: NOW,
      })
    ).rejects.toThrow(/network/)
  })

  it('surfaces an anchor rejection of the signed challenge', async () => {
    const rejecting = ((url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 }))
        : Promise.resolve(
            new Response(
              JSON.stringify({ transaction: goodChallenge(), network_passphrase: Networks.TESTNET })
            )
          )) as unknown as typeof fetch
    await expect(
      authenticate({
        anchor,
        toml,
        account: client.publicKey(),
        sign: localSigner,
        fetchImpl: rejecting,
        nowSeconds: NOW,
      })
    ).rejects.toThrow(/bad signature/)
  })
})

describe('jwtExpiry', () => {
  it('reads exp from the payload', () => {
    expect(jwtExpiry(jwt(123))).toBe(123)
  })
  it('is undefined for anything else', () => {
    expect(jwtExpiry('not-a-jwt')).toBeUndefined()
    expect(jwtExpiry('a.b.c')).toBeUndefined()
  })
})
