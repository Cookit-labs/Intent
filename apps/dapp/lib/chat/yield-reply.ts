export interface VenueYield {
  venueName: string
  /** A year's yield as a percentage, read live. */
  apyPercent: number
}

function percent(value: number): string {
  return `${value.toFixed(2)}%`
}

/**
 * What the chat says when asked where an asset earns the most. Written from rates read just now,
 * never by the model, which has no way to know them and would make figures up.
 */
export function yieldReply({
  asset,
  chainName,
  rates,
}: {
  asset: string
  chainName: string
  rates: readonly VenueYield[]
}): string {
  const live = rates
    .filter((r) => Number.isFinite(r.apyPercent) && r.apyPercent >= 0)
    .sort((a, b) => b.apyPercent - a.apyPercent)
  const [best, ...others] = live
  if (best === undefined) {
    return `I couldn't read a live ${asset} rate on ${chainName} just now, so I won't guess. Try again in a moment.`
  }
  const parts = [
    `Right now on ${chainName}, ${asset} earns the most on ${best.venueName}: ${percent(best.apyPercent)} a year.`,
  ]
  if (others.length > 0) {
    parts.push(
      `Other live rates: ${others.map((r) => `${r.venueName} ${percent(r.apyPercent)}`).join(', ')}.`
    )
  }
  parts.push(
    `Rates move all the time, so this isn't a promise of what you'll earn. Say "supply my ${asset} to ${best.venueName}" and I'll set it up for you to review.`
  )
  return parts.join(String.fromCharCode(10, 10))
}
