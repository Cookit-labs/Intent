interface PoolRates {
  supplyIncentiveApyInfo?: { vaultApr?: string; boostedApr?: string } | undefined
}

/** The current rate as NAVI reports it, or nothing if it can't be read. Never an estimate. */
export function naviApy(
  pool: PoolRates
): { basePercent: number; rewardPercent?: number | undefined } | undefined {
  const base = Number(pool.supplyIncentiveApyInfo?.vaultApr)
  const reward = Number(pool.supplyIncentiveApyInfo?.boostedApr)
  if (!Number.isFinite(base) || pool.supplyIncentiveApyInfo?.vaultApr === undefined) {
    return undefined
  }
  return Number.isFinite(reward) && reward > 0
    ? { basePercent: base, rewardPercent: reward }
    : { basePercent: base }
}

function millions(value: number): string {
  return `$${(value / 1_000_000).toFixed(1)}M`
}

export function poolNotes({ availableUsdc }: { availableUsdc: number | undefined }): string[] {
  const withdrawal =
    availableUsdc !== undefined && Number.isFinite(availableUsdc)
      ? `About ${millions(availableUsdc)} of this pool can be withdrawn right now. The rest is lent out, so getting your money back can take longer if many people withdraw at once.`
      : 'Most of a lending pool is lent out, so getting your money back can take longer if many people withdraw at once.'
  return [
    'This rate is not guaranteed. It moves with borrowing demand, sometimes quickly, and any reward part can end.',
    withdrawal,
    'Money in a lending protocol can be lost if its contracts or price feeds fail.',
  ]
}
