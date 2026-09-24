import type { DayUsage } from '../server/sponsor-ledger'

/**
 * The sponsor's daily budget: how much it will pay in a day, and how many
 * times for any one account.
 *
 * A sponsor key is a balance anyone can drain by submitting, so the cap on
 * a single fee (`fee-bump.ts`) is not enough on its own; a thousand small
 * fees empty an account as surely as one large one. Pure functions, so the
 * arithmetic is pinned without a key or a transaction.
 */

export const DEFAULT_DAILY_BUDGET_XLM = 50
export const DEFAULT_DAILY_PER_ACCOUNT = 20

const STROOPS_PER_XLM = 10_000_000

type Env = Record<string, string | undefined>

export interface BudgetLimits {
  dailyStroops: bigint
  perAccount: number
}

/**
 * `SPONSOR_DAILY_BUDGET_XLM` and `SPONSOR_DAILY_PER_ACCOUNT`, with the
 * defaults for anything unset or unreadable. Zero is read as zero: a budget
 * of nothing sponsors nothing, which is a way to switch sponsorship off
 * without removing the key.
 */
export function budgetLimits(env: Env = process.env): BudgetLimits {
  let dailyStroops = BigInt(DEFAULT_DAILY_BUDGET_XLM * STROOPS_PER_XLM)
  const xlm = env['SPONSOR_DAILY_BUDGET_XLM']?.trim()
  if (xlm !== undefined && xlm !== '') {
    const parsed = Number(xlm)
    if (Number.isFinite(parsed) && parsed >= 0) {
      dailyStroops = BigInt(Math.round(parsed * STROOPS_PER_XLM))
    }
  }

  let perAccount = DEFAULT_DAILY_PER_ACCOUNT
  const count = env['SPONSOR_DAILY_PER_ACCOUNT']?.trim()
  if (count !== undefined && /^\d+$/.test(count)) perAccount = Number(count)

  return { dailyStroops, perAccount }
}

/** The UTC calendar day, which is the day the ledger keys on. */
export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Whether the day, with a fee just reserved on it, is still within budget.
 * Judged after the reservation rather than before, so the reservation can
 * be the atomic step and this the plain comparison.
 */
export function withinBudget(usage: DayUsage, limits: BudgetLimits): boolean {
  return usage.totalStroops <= limits.dailyStroops && usage.accountCount <= limits.perAccount
}

export interface BudgetReport {
  day: string
  spentXlm: number
  budgetXlm: number
  submissions: number
  perAccount: number
}

/** The day's use in XLM, for `GET /api/sponsor`. */
export function describeBudget(day: string, usage: DayUsage, limits: BudgetLimits): BudgetReport {
  return {
    day,
    spentXlm: Number(usage.totalStroops) / STROOPS_PER_XLM,
    budgetXlm: Number(limits.dailyStroops) / STROOPS_PER_XLM,
    submissions: usage.totalCount,
    perAccount: limits.perAccount,
  }
}
