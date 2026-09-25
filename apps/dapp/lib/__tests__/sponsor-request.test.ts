import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSession } from '../server/session'
import { SESSION_COOKIE } from '../server/session-constants'
import { createSponsorLedger } from '../server/sponsor-ledger'
import { sponsorForRequest } from '../sponsor/sponsor-request'
import { fakeSponsorLedgerDb } from './fakes/sponsor-ledger-db'

/**
 * Sponsorship behind the gate.
 *
 * The access gate stands in front of the pages, not the API, so on mainnet
 * anyone could post to a submit route and have the sponsor pay. When the
 * gate is on, the sponsor pays only for a request that carries the session
 * the gate issues; without one the user's transaction still goes out,
 * paying its own fee, with the reason named. When the gate is off nothing
 * changes. The decision is made here, once, before Horizon or the ledger is
 * asked anything; the routes hand it the request and nothing else.
 */

const user = Keypair.random()
const sponsor = Keypair.random()
const SECRET = 'a'.repeat(48)

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

/** Horizon that knows the sponsor account, remembering what it was asked. */
function horizon(calls: string[]): typeof fetch {
  return ((url: string) => {
    calls.push(url)
    return Promise.resolve(new Response(JSON.stringify({ sequence: '1' }), { status: 200 }))
  }) as unknown as typeof fetch
}

function post(cookie?: string): Request {
  return new Request('http://localhost/api/swap/submit', {
    method: 'POST',
    headers: cookie === undefined ? {} : { cookie },
    body: '{}',
  })
}

/** A configured, funded sponsor with an empty ledger, under the given gate settings. */
function options(calls: string[], env: Record<string, string>) {
  return {
    env: { SPONSOR_SECRET_KEY: sponsor.secret(), ...env },
    fetchImpl: horizon(calls),
    ledger: createSponsorLedger(fakeSponsorLedgerDb().query),
  }
}

beforeEach(() => {
  process.env['AUTH_SECRET'] = SECRET
})

afterEach(() => {
  delete process.env['AUTH_SECRET']
})

describe('sponsorForRequest', () => {
  it('sponsors as before when the gate is off', async () => {
    const out = await sponsorForRequest(
      post(),
      signedByUser(),
      user.publicKey(),
      options([], { ACCESS_GATE: 'off' })
    )
    expect(out.sponsored).toBe(true)
  })

  it('submits unsponsored, and says why, when the gate is on and there is no session', async () => {
    const calls: string[] = []
    const xdr = signedByUser()
    const out = await sponsorForRequest(
      post(),
      xdr,
      user.publicKey(),
      options(calls, { ACCESS_GATE: 'on' })
    )
    expect(out).toEqual({ xdr, sponsored: false, reason: 'no_session' })
    // Decided before Horizon or the ledger is asked anything.
    expect(calls).toEqual([])
  })

  it('sponsors a request that carries a valid session when the gate is on', async () => {
    const out = await sponsorForRequest(
      post(`${SESSION_COOKIE}=${createSession('tester@example.com')}`),
      signedByUser(),
      user.publicKey(),
      options([], { ACCESS_GATE: 'on' })
    )
    expect(out.sponsored).toBe(true)
  })

  it('treats a forged or expired session as none', async () => {
    const xdr = signedByUser()
    const [payload] = createSession('tester@example.com').split('.')
    const forged = `${payload ?? ''}.${'x'.repeat(43)}`
    const expired = createSession('tester@example.com', Date.now() - 8 * 24 * 3_600_000)

    for (const token of [forged, expired]) {
      const out = await sponsorForRequest(
        post(`${SESSION_COOKIE}=${token}`),
        xdr,
        user.publicKey(),
        options([], { ACCESS_GATE: 'on' })
      )
      expect(out).toEqual({ xdr, sponsored: false, reason: 'no_session' })
    }
  })

  it('follows the gate default, so on mainnet a session is needed unless the gate is off', async () => {
    const xdr = signedByUser()
    const out = await sponsorForRequest(
      post(),
      xdr,
      user.publicKey(),
      options([], { NEXT_PUBLIC_STELLAR_NETWORK: 'mainnet' })
    )
    expect(out).toEqual({ xdr, sponsored: false, reason: 'no_session' })
  })

  it('sponsors nobody when the gate is on and no secret can verify a session', async () => {
    // The gate itself fails closed in production without a secret; the
    // sponsor does the same on every network rather than pay for a cookie
    // nothing can check.
    const token = createSession('tester@example.com')
    delete process.env['AUTH_SECRET']
    const xdr = signedByUser()
    const out = await sponsorForRequest(
      post(`${SESSION_COOKIE}=${token}`),
      xdr,
      user.publicKey(),
      options([], { ACCESS_GATE: 'on' })
    )
    expect(out).toEqual({ xdr, sponsored: false, reason: 'no_session' })
  })
})
