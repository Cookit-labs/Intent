import { describe, expect, it } from 'vitest'

import { readPerpFacts } from '../perps/market-facts'
import { createNoetherClient } from '../perps/noether-client'

/**
 * Noether's gateway, live and unauthenticated.
 *
 * Skipped when `SKIP_LIVE` is set, like every other network test here, and
 * skipped cleanly when the gateway itself does not answer: it is a dev-tagged
 * container app and its absence is a fact to report, not a failure of this
 * code. What this catches that the unit tests cannot is the gateway moving
 * underneath them — a renamed field, a contract dropped by a testnet reset,
 * a network switch.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

async function reachable(): Promise<boolean> {
  try {
    await createNoetherClient().readHealth()
    return true
  } catch {
    return false
  }
}

describe.skipIf(SKIP)('the live Noether gateway', () => {
  it('resolves every contract a trade needs from /v1/health', async () => {
    if (!(await reachable())) return
    const health = await createNoetherClient().readHealth()
    expect(health.network).toBe('testnet')
    for (const id of Object.values(health.contracts)) {
      expect(id).toMatch(/^C[A-Z2-7]{55}$/)
    }
  }, 30_000)

  it('lists markets with a fresh oracle price', async () => {
    if (!(await reachable())) return
    const markets = await createNoetherClient().readMarkets()
    expect(markets.length).toBeGreaterThan(0)
    const xlm = markets.find((m) => m.asset === 'XLM')
    expect(xlm).toBeDefined()
    // A price in a plausible band, not a pinned figure: the oracle moves.
    expect(xlm?.markPriceUsd).toBeGreaterThan(0.01)
    expect(xlm?.markPriceUsd).toBeLessThan(10)
    expect(BigInt(xlm?.markPrice ?? '0')).toBeGreaterThan(BigInt(0))
  }, 30_000)

  it('reads open interest per market', async () => {
    if (!(await reachable())) return
    const stats = await createNoetherClient().readStats()
    expect(stats.length).toBeGreaterThan(0)
    for (const s of stats) {
      expect(BigInt(s.openInterestLong)).toBeGreaterThanOrEqual(BigInt(0))
      expect(BigInt(s.openInterestShort)).toBeGreaterThanOrEqual(BigInt(0))
    }
  }, 30_000)

  it('shapes the facts the agents are handed', async () => {
    if (!(await reachable())) return
    const facts = await readPerpFacts(createNoetherClient())
    // Undefined is a legitimate answer when the market is paused.
    if (facts === undefined) return
    expect(facts.venue).toBe('noether')
    expect(facts.markets.some((m) => m.asset === 'XLM')).toBe(true)
  }, 30_000)

  it('still gates key issuance, which is why the venue is not marked as executing', async () => {
    if (!(await reachable())) return
    // If this starts failing, the beta has opened and the sign path can be
    // exercised end to end; `venues.ts` should then be revisited.
    const status = await createNoetherClient().betaStatus(
      'GDA4JVVUE6CTF7FEGOFMKA3YE4E5J7SAAK7RACZLNIMXYF24OLLR3KZO'
    )
    expect(status.gated).toBe(true)
  }, 30_000)
})
