type Env = Record<string, string | undefined>

/** The most one payout may pay in naira, on every chain, unless `NAIRA_MAX_NGN` says otherwise. */
export const DEFAULT_MAX_NGN = 2_000_000

/** Per payout, so one mistake or one stolen session is bounded. */
export function maxNgn(env: Env = process.env): number {
  const raw = Number(env['NAIRA_MAX_NGN'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_NGN
}

/** The largest of the naira estimates there are, since either provider may end up paying. */
export function largestNaira(estimates: readonly (number | undefined)[]): number | undefined {
  const usable = estimates.filter((n): n is number => n !== undefined && Number.isFinite(n))
  return usable.length === 0 ? undefined : Math.max(...usable)
}

export function nairaLimitMessage(env: Env = process.env): string {
  return `One payout is limited to ₦${maxNgn(env).toLocaleString('en-US')}. Send less, or split it into more than one payout. Nothing was signed or sent.`
}
