import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cancelRule,
  clearRules,
  loadRules,
  markFired,
  reportDue,
  saveRule,
  syncRules,
} from '../standing-store'
import type { StandingIntent } from '../standing-intent'

/**
 * Where standing rules live between visits.
 *
 * A rule that vanishes on reload is not a standing rule. The local copy is
 * what the panel reads synchronously; the server is the record, because the
 * server is what watches rules while no tab is open. Every write goes to
 * both, and `syncRules` refills the local copy from the server.
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
  // Every write also goes to the server. Answered blandly here so the local
  // behaviour can be tested on its own; the server half has its own block.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"rules":[]}', { status: 200 }))
  )
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

/**
 * The server is the record.
 *
 * Writes are fire-and-forget, as they are for chat history: the local copy
 * is written first so the panel never waits on a request, the server is told
 * after, and a failure is logged rather than thrown. `syncRules` reconciles.
 */
describe('writes reach the server', () => {
  const WALLET = 'G'.padEnd(56, 'A')
  let calls: { url: string; init: RequestInit }[]
  let respond: () => Response

  /** Lets a fire-and-forget request run. */
  const flush = () => new Promise((r) => setTimeout(r, 0))

  function body(i: number): Record<string, unknown> {
    return JSON.parse(String(calls[i]?.init.body)) as Record<string, unknown>
  }

  beforeEach(() => {
    calls = []
    respond = () => new Response('{"rules":[]}', { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return respond()
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts a new rule with the wallet it trades from', async () => {
    const saved = rule()
    saveRule(saved, WALLET)
    await flush()

    expect(calls[0]?.url).toBe('/api/standing')
    expect(calls[0]?.init.method).toBe('POST')
    expect(body(0)).toEqual({ wallet: WALLET, rule: saved })
  })

  it('cancels on the server', async () => {
    saveRule(rule({ id: 'x' }), WALLET)
    cancelRule('x')
    await flush()

    expect(calls[1]?.url).toBe('/api/standing?id=x')
    expect(calls[1]?.init.method).toBe('DELETE')
  })

  it('reports an execution as fired and already dealt with', async () => {
    // The user signed it themselves: the tick must not fire it again, and
    // there is nothing to email or to show in the inbox.
    saveRule(rule({ id: 'x' }), WALLET)
    markFired('x', 'a'.repeat(64))
    await flush()

    expect(calls[1]?.url).toBe('/api/standing')
    expect(calls[1]?.init.method).toBe('PATCH')
    expect(body(1)).toMatchObject({ id: 'x', executed: true })
    expect(typeof body(1)['at']).toBe('string')
  })

  it('reports a rule that came due in this tab, with the price', async () => {
    // Seen here means seen. Without this the tick would find the same
    // condition met and prompt a second time by email.
    reportDue('x', 0.155, new Date('2026-09-23T11:00:00.000Z'))
    await flush()

    expect(calls[0]?.init.method).toBe('PATCH')
    expect(body(0)).toEqual({ id: 'x', at: '2026-09-23T11:00:00.000Z', price: 0.155 })
  })

  it('a server failure is logged, not thrown, and the local copy still holds the rule', async () => {
    respond = () => new Response('down', { status: 500 })

    expect(() => saveRule(rule({ id: 'x' }), WALLET)).not.toThrow()
    await flush()

    expect(loadRules('stellar')[0]?.id).toBe('x')
    expect(console.warn).toHaveBeenCalled()
  })

  it('no session is silence, not a warning', async () => {
    // Without a session there is no owner to file the rule under. The rule
    // still works locally and a sign-in prompt belongs at connect time, not
    // in the console on every save.
    respond = () => new Response('{"error":"unauthorised"}', { status: 401 })

    saveRule(rule({ id: 'x' }), WALLET)
    await flush()

    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('syncRules', () => {
  const WALLET = 'G'.padEnd(56, 'A')

  function remote(over: Partial<StandingIntent>, extra: Record<string, unknown> = {}) {
    const r = rule(over)
    return {
      id: r.id,
      email: 'alice@test.com',
      wallet: WALLET,
      chain: r.chain,
      rule: r,
      status: r.status,
      createdAt: r.createdAt,
      firedAt: null,
      firedPrice: null,
      notifiedAt: null,
      seenAt: null,
      ...extra,
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refills from the server, keeping local hashes and rules the server has not seen', async () => {
    saveRule(rule({ id: 'x' }))
    markFired('x', 'a'.repeat(64))
    saveRule(rule({ id: 'unsynced' }))

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              rules: [
                // Fired by the tick: the server's status wins over the local one.
                remote(
                  { id: 'x', status: 'fired', lastFiredAt: '2026-09-23T11:00:00.000Z' },
                  { firedAt: '2026-09-23T11:00:00.000Z', firedPrice: 0.155 }
                ),
                // Created on another device.
                remote({ id: 'elsewhere' }),
              ],
            }),
            { status: 200 }
          )
      )
    )

    const synced = await syncRules('stellar', WALLET)

    const ids = synced.map((r) => r.id).sort()
    expect(ids).toEqual(['elsewhere', 'unsynced', 'x'])
    const x = synced.find((r) => r.id === 'x')
    expect(x?.status).toBe('fired')
    expect(x?.lastFiredAt).toBe('2026-09-23T11:00:00.000Z')
    expect(x?.lastTxHash).toBe('a'.repeat(64))
    expect(
      loadRules('stellar')
        .map((r) => r.id)
        .sort()
    ).toEqual(ids)
  })

  it('asks for the wallet’s rules on this chain', async () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response('{"rules":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await syncRules('stellar', WALLET)

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`/api/standing?chain=stellar&wallet=${WALLET}`)
  })

  it('falls back to the local copy when the server cannot be reached', async () => {
    saveRule(rule({ id: 'x' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const synced = await syncRules('stellar', WALLET)

    expect(synced.map((r) => r.id)).toEqual(['x'])
  })
})
