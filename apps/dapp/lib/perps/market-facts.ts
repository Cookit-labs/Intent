import type { NoetherClient } from './noether-client'

/**
 * Noether's live figures, shaped as facts an agent may reason from.
 *
 * Supplied rather than recalled, for the same reason prices and lending rates
 * are: a model asked to remember a perp market's open interest will invent
 * one. Read with the same silent-failure discipline as `fetchLendingRates` —
 * a competition should not collapse because a perps gateway was down, and an
 * agent given no figures simply has nothing to say about perps.
 *
 * What is *not* here is a funding rate. The gateway exposes none (its spec,
 * read 2026-09-23, has no funding field anywhere); the contract accrues
 * funding on a position on-chain. The prompt says so rather than leaving
 * the model to fill the gap from memory.
 */

export interface PerpMarketFact {
  asset: string
  /** The oracle's mark price. */
  markPriceUsd: number
  /** USD notional. Absent when the stats read failed for this market. */
  openInterestLongUsd?: number
  openInterestShortUsd?: number
  openPositions?: number
}

export interface PerpFacts {
  venue: 'noether'
  /** As the gateway reports it — `0.0.0-dev` at the time of writing. */
  version: string
  /** The best annualised APY among the venue's vaults, when any reports one. */
  vaultApyPct?: number
  markets: PerpMarketFact[]
}

/** 7-decimal base units to USD, two places. */
function usd(baseUnits: string): number {
  const n = Number(BigInt(baseUnits)) / 1e7
  return Math.round(n * 100) / 100
}

export async function readPerpFacts(client: NoetherClient): Promise<PerpFacts | undefined> {
  let health
  try {
    health = await client.readHealth()
  } catch {
    return undefined
  }
  // A paused market accepts no opens. Figures from it would tempt an agent
  // to reason about a venue no intent can reach right now.
  if (health.paused) return undefined

  let markets
  try {
    markets = await client.readMarkets()
  } catch {
    return undefined
  }
  if (markets.length === 0) return undefined

  // Stats and vaults are extras. Prices alone are worth stating; the open
  // interest is simply unknown when its read fails.
  const [stats, vaults] = await Promise.all([
    client.readStats().catch(() => []),
    client.readVaults().catch(() => []),
  ])
  const statsByAsset = new Map(stats.map((s) => [s.asset, s]))

  const facts: PerpMarketFact[] = markets.map((m) => {
    const s = statsByAsset.get(m.asset)
    return {
      asset: m.asset,
      markPriceUsd: m.markPriceUsd,
      ...(s !== undefined
        ? {
            openInterestLongUsd: usd(s.openInterestLong),
            openInterestShortUsd: usd(s.openInterestShort),
            openPositions: s.openPositions,
          }
        : {}),
    }
  })

  const apys = vaults.map((v) => v.apyBps)
  const best = apys.length > 0 ? Math.max(...apys) : undefined

  return {
    venue: 'noether',
    version: health.version,
    ...(best !== undefined ? { vaultApyPct: best / 100 } : {}),
    markets: facts,
  }
}
