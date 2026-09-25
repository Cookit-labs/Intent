import { Keypair } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BudgetReport } from '../sponsor/budget'

/**
 * `GET /api/sponsor`: whether fees are covered, from which account, and
 * how much of today's budget is spent.
 *
 * The budget report is faked at the module boundary; what it says is the
 * ledger's business and is tested with the ledger. What is pinned here is
 * that the route passes the report through when there is one, and answers
 * without it when there is not, rather than failing — and that a key with no
 * ledger configured is reported as what it is: no sponsorship, with the
 * reason, since `sponsorForSubmission` refuses to sponsor in that state.
 */

const report = vi.fn<() => Promise<BudgetReport | undefined>>()

vi.mock('../sponsor/sponsor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sponsor/sponsor')>()
  return { ...actual, sponsorBudgetToday: () => report() }
})

const SPONSOR = Keypair.random()
const LEDGER = 'postgresql://intent@localhost/intent'

beforeEach(() => {
  delete process.env['SPONSOR_SECRET_KEY']
  delete process.env['DATABASE_URL']
  report.mockReset()
})

afterEach(() => {
  delete process.env['SPONSOR_SECRET_KEY']
  delete process.env['DATABASE_URL']
})

describe('GET /api/sponsor', () => {
  it("reports today's budget beside the sponsor", async () => {
    process.env['SPONSOR_SECRET_KEY'] = SPONSOR.secret()
    process.env['DATABASE_URL'] = LEDGER
    report.mockResolvedValue({
      day: '2026-09-24',
      spentXlm: 1.5,
      budgetXlm: 50,
      submissions: 12,
      perAccount: 20,
    })
    const { GET } = await import('../../app/api/sponsor/route')

    expect(await (await GET()).json()).toEqual({
      sponsored: true,
      account: SPONSOR.publicKey(),
      budget: { day: '2026-09-24', spentXlm: 1.5, budgetXlm: 50, submissions: 12, perAccount: 20 },
    })
  })

  it('answers without a budget when the ledger cannot be read', async () => {
    process.env['DATABASE_URL'] = LEDGER
    report.mockResolvedValue(undefined)
    const { GET } = await import('../../app/api/sponsor/route')

    expect(await (await GET()).json()).toEqual({ sponsored: false })
  })

  it('reports a key with no ledger configured as unsponsored, and says why', async () => {
    process.env['SPONSOR_SECRET_KEY'] = SPONSOR.secret()
    report.mockResolvedValue(undefined)
    const { GET } = await import('../../app/api/sponsor/route')

    expect(await (await GET()).json()).toEqual({
      sponsored: false,
      account: SPONSOR.publicKey(),
      reason: 'no_ledger',
    })
    // Nothing to read from a ledger that is not there.
    expect(report).not.toHaveBeenCalled()
  })
})
