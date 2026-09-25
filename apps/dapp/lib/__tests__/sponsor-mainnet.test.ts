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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSponsorLedger } from '../server/sponsor-ledger'
import { fakeSponsorLedgerDb } from './fakes/sponsor-ledger-db'

/**
 * Sponsorship on mainnet.
 *
 * Friendbot is a testnet convenience and nothing on mainnet may reach for
 * it. An unfunded sponsor there is simply unfunded: the user's transaction
 * goes out paying its own fee, with the reason recorded, exactly as every
 * other sponsorship failure does. A funded sponsor wraps as before, with the
 * public network's passphrase.
 */

const user = Keypair.random()
const sponsor = Keypair.random()

function signedByUser(passphrase: string): string {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
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

// Loaded once: the import re-reads the SDK-backed module from scratch, which
// is slow with the whole suite running alongside.
let mainnet: typeof import('../sponsor/sponsor')

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  vi.resetModules()
  mainnet = await import('../sponsor/sponsor')
  vi.unstubAllEnvs()
}, 60_000)

afterAll(() => {
  vi.resetModules()
})

function onMainnet(): Promise<typeof import('../sponsor/sponsor')> {
  return Promise.resolve(mainnet)
}

describe('sponsorForSubmission on mainnet', () => {
  it('never calls friendbot: an unfunded sponsor means an unsponsored submission', async () => {
    const { sponsorForSubmission } = await onMainnet()
    const xdr = signedByUser(Networks.PUBLIC)
    const calls: string[] = []
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
      fetchImpl: horizon(false, calls),
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'sponsor_unfunded' })
    expect(calls.some((u) => u.includes('friendbot'))).toBe(false)
    expect(calls.some((u) => u.includes('https://horizon.stellar.org/accounts/'))).toBe(true)
  })

  it('wraps a funded sponsor with the public passphrase', async () => {
    const { sponsorForSubmission } = await onMainnet()
    const calls: string[] = []
    const out = await sponsorForSubmission(signedByUser(Networks.PUBLIC), user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
      fetchImpl: horizon(true, calls),
      // A ledger, because without one there is no sponsorship to test.
      ledger: createSponsorLedger(fakeSponsorLedgerDb().query),
    })
    expect(out.sponsored).toBe(true)
    const tx = TransactionBuilder.fromXDR(out.xdr, Networks.PUBLIC)
    expect(tx).toBeInstanceOf(FeeBumpTransaction)
    expect((tx as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey())
    expect(calls.some((u) => u.includes('friendbot'))).toBe(false)
  })
})
