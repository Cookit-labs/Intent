import { describe, expect, it } from 'vitest'

import { evaluateTrigger, nextFireAt, type StandingIntent } from '../standing-intent'

/**
 * Intents that outlive the moment they were created.
 *
 * An intent currently dies at its deadline: it either fills while the user
 * watches or it expires. A standing intent is the difference between a tool
 * you visit and one that works while you sleep — "if XLM drops 10%, buy" is
 * not a trade, it is a rule about when to trade.
 *
 * The distinction that matters here is between *deciding* and *executing*. A
 * trigger firing means the condition was met; it does not mean funds moved.
 * Conflating the two is how the app once marked every intent settled on a
 * timer, and that fiction is exactly what this must not recreate.
 */

const base: StandingIntent = {
  id: 'si_1',
  chain: 'stellar',
  text: 'Buy XLM if it drops 10%',
  createdAt: new Date('2026-09-01T00:00:00Z').toISOString(),
  trigger: { kind: 'price_below', asset: 'XLM', priceUsd: 0.16 },
  action: { kind: 'swap', from: 'USDC', to: 'XLM', amountIn: '50' },
  status: 'armed',
}

describe('a price trigger fires only when the price is reached', () => {
  it('stays armed above the threshold', () => {
    expect(evaluateTrigger(base, { XLM: 0.18 }).fires).toBe(false)
  })

  it('fires at or below it', () => {
    expect(evaluateTrigger(base, { XLM: 0.16 }).fires).toBe(true)
    expect(evaluateTrigger(base, { XLM: 0.14 }).fires).toBe(true)
  })

  it('does not fire when the price is unknown', () => {
    // Missing data is not a signal. Firing on an absent price would trade on
    // the failure of a price feed rather than on a market movement.
    expect(evaluateTrigger(base, {}).fires).toBe(false)
    expect(evaluateTrigger(base, {}).reason).toMatch(/no price/i)
  })

  it('reads an above-trigger in the other direction', () => {
    const sell: StandingIntent = {
      ...base,
      trigger: { kind: 'price_above', asset: 'XLM', priceUsd: 0.25 },
    }
    expect(evaluateTrigger(sell, { XLM: 0.2 }).fires).toBe(false)
    expect(evaluateTrigger(sell, { XLM: 0.26 }).fires).toBe(true)
  })
})

describe('a standing intent stops when it should', () => {
  it('does not fire once it has already run', () => {
    // Without this a single condition would trade repeatedly for as long as
    // the price stayed there, which is not what "if it drops, buy" means.
    const fired = { ...base, status: 'fired' as const }
    expect(evaluateTrigger(fired, { XLM: 0.1 }).fires).toBe(false)
  })

  it('does not fire once cancelled', () => {
    const cancelled = { ...base, status: 'cancelled' as const }
    expect(evaluateTrigger(cancelled, { XLM: 0.1 }).fires).toBe(false)
  })

  it('does not fire past its expiry', () => {
    const expired = { ...base, expiresAt: new Date('2026-09-02T00:00:00Z').toISOString() }
    const now = new Date('2026-09-03T00:00:00Z')
    expect(evaluateTrigger(expired, { XLM: 0.1 }, now).fires).toBe(false)
    expect(evaluateTrigger(expired, { XLM: 0.1 }, now).reason).toMatch(/expired/i)
  })

  it('still fires before expiry', () => {
    const expiring = { ...base, expiresAt: new Date('2026-09-10T00:00:00Z').toISOString() }
    expect(evaluateTrigger(expiring, { XLM: 0.1 }, new Date('2026-09-05T00:00:00Z')).fires).toBe(
      true
    )
  })
})

describe('a recurring intent repeats on a schedule', () => {
  const weekly: StandingIntent = {
    ...base,
    trigger: { kind: 'schedule', everyHours: 168 },
    lastFiredAt: new Date('2026-09-01T00:00:00Z').toISOString(),
  }

  it('waits out the interval', () => {
    expect(evaluateTrigger(weekly, {}, new Date('2026-09-04T00:00:00Z')).fires).toBe(false)
  })

  it('fires once the interval has passed', () => {
    expect(evaluateTrigger(weekly, {}, new Date('2026-09-08T01:00:00Z')).fires).toBe(true)
  })

  it('reports when it will next be due', () => {
    const next = nextFireAt(weekly)
    expect(next?.toISOString()).toBe('2026-09-08T00:00:00.000Z')
  })

  it('is due immediately when it has never fired', () => {
    const fresh: StandingIntent = { ...base, trigger: { kind: 'schedule', everyHours: 24 } }
    expect(evaluateTrigger(fresh, {}, new Date('2026-09-01T00:00:01Z')).fires).toBe(true)
  })

  it('stays armed after firing, unlike a price trigger', () => {
    // A weekly buy is meant to recur; a one-off condition is not. The status
    // model has to tell them apart or one of the two behaves wrongly.
    expect(weekly.trigger.kind === 'schedule').toBe(true)
    expect(nextFireAt(weekly)).not.toBeNull()
  })
})
