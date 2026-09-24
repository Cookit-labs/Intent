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
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QueryFn } from '../server/db'
import { createSponsorLedger, type SponsorLedger } from '../server/sponsor-ledger'
import { sponsorBudgetToday, sponsorConfigured, sponsorForSubmission } from '../sponsor/sponsor'
import { fakeSponsorLedgerDb } from './fakes/sponsor-ledger-db'

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

/** A ledger with nothing spent today. */
function emptyLedger(): SponsorLedger {
  return createSponsorLedger(fakeSponsorLedgerDb().query)
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
      ledger: emptyLedger(),
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
      ledger: emptyLedger(),
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

/**
 * The daily budget. A sponsor key is a balance anyone can drain by
 * submitting, so what it will pay in a day is capped, and so is what it
 * pays for any one account. A refusal is the same fallback as every other:
 * the user's own transaction, paying its own fee, with the reason named.
 */
describe('the daily budget', () => {
  const NOW = new Date('2026-09-24T12:00:00.000Z')
  const DAY = '2026-09-24'
  const env = { SPONSOR_SECRET_KEY: sponsor.secret() }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records the fee it commits to, for the account and for the day', async () => {
    const ledger = emptyLedger()
    const out = await sponsorForSubmission(signedByUser(), user.publicKey(), {
      env,
      fetchImpl: horizon(true, []),
      ledger,
      now: NOW,
    })
    expect(out.sponsored).toBe(true)
    // One operation at the base fee, plus the bump itself: 200 stroops.
    expect(await ledger.usage(DAY, user.publicKey())).toEqual({
      totalStroops: BigInt(200),
      totalCount: 1,
      accountStroops: BigInt(200),
      accountCount: 1,
    })
  })

  it('falls back to unsponsored when the day would go over budget', async () => {
    const ledger = emptyLedger()
    // Fifty XLM less a hundred stroops: the next 200-stroop fee tips it.
    await ledger.record(DAY, Keypair.random().publicKey(), BigInt(500_000_000 - 100))

    const xdr = signedByUser()
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      env,
      fetchImpl: horizon(true, []),
      ledger,
      now: NOW,
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'budget' })
    // The fee was reserved and then released: a refusal leaves the day as
    // it found it.
    expect(await ledger.usage(DAY, user.publicKey())).toMatchObject({
      totalStroops: BigInt(500_000_000 - 100),
      totalCount: 1,
      accountCount: 0,
    })
  })

  it('keeps refusing when a reservation over budget cannot be released', async () => {
    // The reservation is what makes the cap hold under concurrent
    // submissions; a release that fails leaves the day over-counted, which
    // errs the safe way. What must not happen is the failure turning into
    // an allow.
    vi.resetModules()
    const fresh = await import('../sponsor/sponsor')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const db = fakeSponsorLedgerDb()
    await createSponsorLedger(db.query).record(
      DAY,
      Keypair.random().publicKey(),
      BigInt(500_000_000 - 100)
    )
    const releaseFails: QueryFn = async (sql, params) => {
      if (sql.trim().startsWith('UPDATE')) throw new Error('connect ECONNRESET')
      return db.query(sql, params)
    }

    const xdr = signedByUser()
    const out = await fresh.sponsorForSubmission(xdr, user.publicKey(), {
      env,
      fetchImpl: horizon(true, []),
      ledger: createSponsorLedger(releaseFails),
      now: NOW,
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'budget' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[sponsor-ledger]')
  })

  it('falls back when this account has had its share for the day', async () => {
    const ledger = emptyLedger()
    await ledger.record(DAY, user.publicKey(), BigInt(200))
    await ledger.record(DAY, user.publicKey(), BigInt(200))

    const xdr = signedByUser()
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      env: { ...env, SPONSOR_DAILY_PER_ACCOUNT: '2' },
      fetchImpl: horizon(true, []),
      ledger,
      now: NOW,
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'budget' })
  })

  it('reads the budget from the environment', async () => {
    const xdr = signedByUser()
    const out = await sponsorForSubmission(xdr, user.publicKey(), {
      // A hundred stroops a day; the fee is two hundred.
      env: { ...env, SPONSOR_DAILY_BUDGET_XLM: '0.00001' },
      fetchImpl: horizon(true, []),
      ledger: emptyLedger(),
      now: NOW,
    })
    expect(out).toEqual({ xdr, sponsored: false, reason: 'budget' })
  })

  it('counts yesterday against nothing', async () => {
    const ledger = emptyLedger()
    await ledger.record('2026-09-23', user.publicKey(), BigInt(500_000_000))

    const out = await sponsorForSubmission(signedByUser(), user.publicKey(), {
      env,
      fetchImpl: horizon(true, []),
      ledger,
      now: NOW,
    })
    expect(out.sponsored).toBe(true)
  })

  it('still sponsors, and warns once, when the ledger cannot be reached', async () => {
    // A fresh module, so the once-per-process flag starts clear here.
    vi.resetModules()
    const fresh = await import('../sponsor/sponsor')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const db = fakeSponsorLedgerDb()
    db.down = new Error('connect ECONNREFUSED 127.0.0.1:55432')
    const ledger = createSponsorLedger(db.query)

    for (let i = 0; i < 2; i += 1) {
      const out = await fresh.sponsorForSubmission(signedByUser(), user.publicKey(), {
        env,
        fetchImpl: horizon(true, []),
        ledger,
        now: NOW,
      })
      expect(out.sponsored).toBe(true)
    }

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[sponsor-ledger]')
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED')
  })
})

describe('sponsorBudgetToday', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("describes the day's use from the ledger", async () => {
    const ledger = emptyLedger()
    await ledger.record('2026-09-24', user.publicKey(), BigInt(15_000_000))

    const report = await sponsorBudgetToday({
      env: {},
      ledger,
      now: new Date('2026-09-24T12:00:00.000Z'),
    })
    expect(report).toEqual({
      day: '2026-09-24',
      spentXlm: 1.5,
      budgetXlm: 50,
      submissions: 1,
      perAccount: 20,
    })
  })

  it('is undefined when the ledger cannot be reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = fakeSponsorLedgerDb()
    db.down = new Error('connect ECONNREFUSED 127.0.0.1:55432')

    const report = await sponsorBudgetToday({ env: {}, ledger: createSponsorLedger(db.query) })
    expect(report).toBeUndefined()
  })
})
