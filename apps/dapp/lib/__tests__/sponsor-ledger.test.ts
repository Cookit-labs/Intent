import { beforeEach, describe, expect, it } from 'vitest'

import { createSponsorLedger, type SponsorLedger } from '../server/sponsor-ledger'
import {
  DEFAULT_DAILY_BUDGET_XLM,
  DEFAULT_DAILY_PER_ACCOUNT,
  budgetLimits,
  dayOf,
  describeBudget,
  withinBudget,
} from '../sponsor/budget'
import { fakeSponsorLedgerDb, type FakeSponsorLedgerDb } from './fakes/sponsor-ledger-db'

/**
 * What the sponsor has committed today, and whether it can commit more.
 *
 * The ledger is the record: one row per account per day, and a `*` row for
 * the day as a whole, both bumped by the same statement so they cannot
 * drift. The budget decision is pure — usage in, yes or no out — so the
 * arithmetic is pinned here without a sponsor key or a transaction.
 */

const DAY = '2026-09-24'
const A = 'G'.padEnd(56, 'A')
const B = 'G'.padEnd(56, 'B')

let db: FakeSponsorLedgerDb
let ledger: SponsorLedger

beforeEach(() => {
  db = fakeSponsorLedgerDb()
  ledger = createSponsorLedger(db.query)
})

describe('createSponsorLedger', () => {
  it('reports nothing spent on a day with no rows', async () => {
    expect(await ledger.usage(DAY, A)).toEqual({
      totalStroops: BigInt(0),
      totalCount: 0,
      accountStroops: BigInt(0),
      accountCount: 0,
    })
  })

  it('records a fee against the account and against the day', async () => {
    await ledger.record(DAY, A, BigInt(100))
    await ledger.record(DAY, A, BigInt(250))
    await ledger.record(DAY, B, BigInt(100))

    expect(await ledger.usage(DAY, A)).toEqual({
      totalStroops: BigInt(450),
      totalCount: 3,
      accountStroops: BigInt(350),
      accountCount: 2,
    })
  })

  it('keeps days apart', async () => {
    await ledger.record('2026-09-23', A, BigInt(100))
    await ledger.record(DAY, A, BigInt(1))

    const today = await ledger.usage(DAY, A)
    expect(today.totalStroops).toBe(BigInt(1))
    expect(today.accountCount).toBe(1)
  })

  it('answers the day total alone when no account is named', async () => {
    await ledger.record(DAY, A, BigInt(100))
    expect(await ledger.usage(DAY)).toEqual({
      totalStroops: BigInt(100),
      totalCount: 1,
      accountStroops: BigInt(0),
      accountCount: 0,
    })
  })

  it('creates the schema before anything else', async () => {
    await ledger.ensureSchema()
    expect(db.log.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS sponsor_ledger'))).toBe(true)
  })
})

describe('budgetLimits', () => {
  it('defaults to 50 XLM a day and 20 submissions an account', () => {
    expect(DEFAULT_DAILY_BUDGET_XLM).toBe(50)
    expect(DEFAULT_DAILY_PER_ACCOUNT).toBe(20)
    expect(budgetLimits({})).toEqual({ dailyStroops: BigInt(500_000_000), perAccount: 20 })
  })

  it('reads the environment, XLM with decimals', () => {
    expect(
      budgetLimits({ SPONSOR_DAILY_BUDGET_XLM: '12.5', SPONSOR_DAILY_PER_ACCOUNT: '3' })
    ).toEqual({ dailyStroops: BigInt(125_000_000), perAccount: 3 })
  })

  it('takes zero as zero: a budget of nothing sponsors nothing', () => {
    expect(budgetLimits({ SPONSOR_DAILY_BUDGET_XLM: '0' }).dailyStroops).toBe(BigInt(0))
    expect(budgetLimits({ SPONSOR_DAILY_PER_ACCOUNT: '0' }).perAccount).toBe(0)
  })

  it('keeps the default when a value cannot be read', () => {
    expect(budgetLimits({ SPONSOR_DAILY_BUDGET_XLM: 'lots' }).dailyStroops).toBe(
      BigInt(500_000_000)
    )
    expect(budgetLimits({ SPONSOR_DAILY_BUDGET_XLM: '-1' }).dailyStroops).toBe(BigInt(500_000_000))
    expect(budgetLimits({ SPONSOR_DAILY_PER_ACCOUNT: '2.5' }).perAccount).toBe(20)
  })
})

describe('withinBudget', () => {
  const limits = { dailyStroops: BigInt(1000), perAccount: 2 }
  const usage = (totalStroops: number, accountCount: number) => ({
    totalStroops: BigInt(totalStroops),
    totalCount: accountCount,
    accountStroops: BigInt(0),
    accountCount,
  })

  it('allows a fee that fits, up to and including the whole budget', () => {
    expect(withinBudget(usage(0, 0), BigInt(200), limits)).toBe(true)
    expect(withinBudget(usage(800, 0), BigInt(200), limits)).toBe(true)
  })

  it('refuses a fee that would take the day over budget', () => {
    expect(withinBudget(usage(801, 0), BigInt(200), limits)).toBe(false)
  })

  it('refuses an account that has had its share for the day', () => {
    expect(withinBudget(usage(0, 1), BigInt(200), limits)).toBe(true)
    expect(withinBudget(usage(0, 2), BigInt(200), limits)).toBe(false)
  })
})

describe('dayOf', () => {
  it('is the UTC calendar day', () => {
    expect(dayOf(new Date('2026-09-24T23:59:59.000Z'))).toBe('2026-09-24')
    expect(dayOf(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25')
  })
})

describe('describeBudget', () => {
  it('reports the day in XLM, for the sponsor route', () => {
    const usage = {
      totalStroops: BigInt(12_345_600),
      totalCount: 7,
      accountStroops: BigInt(0),
      accountCount: 0,
    }
    expect(describeBudget(DAY, usage, budgetLimits({}))).toEqual({
      day: DAY,
      spentXlm: 1.23456,
      budgetXlm: 50,
      submissions: 7,
      perAccount: 20,
    })
  })
})
