import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelRule, clearRules, loadRules, markFired, saveRule } from '../standing-store'
import type { StandingIntent } from '../standing-intent'

/**
 * Where standing rules live between visits.
 *
 * A rule that vanishes on reload is not a standing rule. This is deliberately
 * the same localStorage-shaped store the chat history uses rather than the
 * backend: a rule only fires while something is watching, and today the only
 * watcher is the browser tab. Storing it server-side would imply it fires
 * without one, which would be a lie until a server-side watcher exists.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
})

function rule(over: Partial<StandingIntent> = {}): StandingIntent {
  return {
    id: 'si_1',
    chain: 'stellar',
    text: 'Buy $50 of XLM if it drops to $0.16',
    createdAt: new Date().toISOString(),
    trigger: { kind: 'price_below', asset: 'XLM', priceUsd: 0.16 },
    action: { kind: 'swap', from: 'USDC', to: 'XLM', amountIn: '50' },
    status: 'armed',
    ...over,
  }
}

describe('rules survive a reload', () => {
  it('keeps a saved rule', () => {
    saveRule(rule())
    expect(loadRules('stellar')[0]?.text).toBe('Buy $50 of XLM if it drops to $0.16')
  })

  it('scopes rules to their chain', () => {
    saveRule(rule({ id: 'a', chain: 'stellar' }))
    saveRule(rule({ id: 'b', chain: 'arc' }))
    expect(loadRules('stellar').map((r) => r.id)).toEqual(['a'])
  })

  it('replaces a rule rather than duplicating it', () => {
    saveRule(rule({ id: 'same' }))
    saveRule(rule({ id: 'same', status: 'cancelled' }))
    const all = loadRules('stellar')
    expect(all).toHaveLength(1)
    expect(all[0]?.status).toBe('cancelled')
  })

  it('survives unreadable storage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      },
    })
    expect(() => saveRule(rule())).not.toThrow()
    expect(loadRules('stellar')).toEqual([])
  })
})

describe('firing is recorded, not inferred', () => {
  it('records the hash that actually executed', () => {
    // The distinction this whole feature turns on: a trigger firing is a
    // decision, and only a transaction makes it a trade. Storing the hash is
    // what keeps the two apart.
    saveRule(rule({ id: 'x' }))
    markFired('x', 'a'.repeat(64))

    const found = loadRules('stellar')[0]
    expect(found?.status).toBe('fired')
    expect(found?.lastTxHash).toBe('a'.repeat(64))
    expect(found?.lastFiredAt).toBeDefined()
  })

  it('keeps a scheduled rule armed after it fires', () => {
    // A weekly buy is meant to recur. Marking it spent would turn every
    // recurring rule into a one-off on its first run.
    saveRule(rule({ id: 'weekly', trigger: { kind: 'schedule', everyHours: 168 } }))
    markFired('weekly', 'b'.repeat(64))

    const found = loadRules('stellar')[0]
    expect(found?.status).toBe('armed')
    expect(found?.lastFiredAt).toBeDefined()
  })

  it('ignores a firing for a rule that is gone', () => {
    saveRule(rule({ id: 'x' }))
    markFired('missing', 'c'.repeat(64))
    expect(loadRules('stellar')).toHaveLength(1)
  })
})

describe('rules can be withdrawn', () => {
  it('cancels without deleting the record', () => {
    // Kept rather than removed: a user should be able to see that a rule
    // existed and was stopped, not have it silently disappear.
    saveRule(rule({ id: 'x' }))
    cancelRule('x')
    expect(loadRules('stellar')[0]?.status).toBe('cancelled')
  })

  it('clears only the chain asked for', () => {
    saveRule(rule({ id: 'a', chain: 'stellar' }))
    saveRule(rule({ id: 'b', chain: 'arc' }))
    clearRules('stellar')
    expect(loadRules('stellar')).toHaveLength(0)
    expect(loadRules('arc')).toHaveLength(1)
  })
})
