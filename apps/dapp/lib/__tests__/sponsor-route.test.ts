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
 * without it when there is not, rather than failing.
 */

const report = vi.fn<() => Promise<BudgetReport | undefined>>()

vi.mock('../sponsor/sponsor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sponsor/sponsor')>()
  return { ...actual, sponsorBudgetToday: () => report() }
})

const SPONSOR = Keypair.random()

beforeEach(() => {
  delete process.env['SPONSOR_SECRET_KEY']
  report.mockReset()
})

afterEach(() => {
  delete process.env['SPONSOR_SECRET_KEY']
})

describe('GET /api/sponsor', () => {
  it("reports today's budget beside the sponsor", async () => {
    process.env['SPONSOR_SECRET_KEY'] = SPONSOR.secret()
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
    report.mockResolvedValue(undefined)
    const { GET } = await import('../../app/api/sponsor/route')

    expect(await (await GET()).json()).toEqual({ sponsored: false })
  })
})
