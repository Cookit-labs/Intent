import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listTurns, saveTurnRemote } from '../api/conversation-client'
import { canReview } from '../agents/chain-race'
import { describePlan, type AgentProposalView } from '../agents/competition'
import { planFinalReveal, planTalkReveal } from '../agents/pacing'
import { saveTurn, syncTurns, type ChatTurn } from '../chat-history'

vi.mock('../api/conversation-client', () => ({
  listTurns: vi.fn().mockResolvedValue([]),
  saveTurnRemote: vi.fn().mockResolvedValue(undefined),
  updateTurnRemote: vi.fn().mockResolvedValue(undefined),
  clearTurnsRemote: vi.fn().mockResolvedValue(undefined),
}))

const view = (over: Partial<AgentProposalView> = {}): AgentProposalView => ({
  key: 'a',
  name: 'A',
  avgPriceUsd: 1,
  vsOraclePct: 0,
  score: 0,
  ...over,
})

describe('canReview', () => {
  const route = { kind: 'chain', venueId: 'ref' }

  it('never offers a held plan, even with a route on the record', () => {
    expect(canReview(view({ held: true }), route, false)).toBe(false)
    expect(canReview(view({ held: true }), route, true)).toBe(false)
    expect(canReview(view({ held: true }), undefined, false)).toBe(false)
  })

  it('offers an ordinary plan with or without a route while the race is live, as before', () => {
    expect(canReview(view(), route, false)).toBe(true)
    expect(canReview(view(), undefined, false)).toBe(true)
  })

  it('treats a reopened plan with no route as nothing to sign, in case its hold was lost', () => {
    expect(canReview(view(), undefined, true)).toBe(false)
    expect(canReview(view(), route, true)).toBe(true)
  })
})

describe('describePlan', () => {
  it('says what a held plan is', () => {
    expect(describePlan({ held: true, executionMode: 'fill' })).toBe('would not do this now')
  })
})

describe('saved talk', () => {
  const store = new Map<string, string>()
  const talk: NonNullable<ChatTurn['talk']> = {
    thread: [
      { type: 'take', agent: 'a' },
      { type: 'line', line: { kind: 'asked', agent: 'a', to: 'b', text: 'Why?' } },
    ],
    takes: { a: view() },
  }
  const turn = (over: Partial<ChatTurn> = {}): ChatTurn => ({
    id: 't',
    chain: 'near',
    text: 'swap',
    createdAt: new Date().toISOString(),
    proposals: {},
    winner: null,
    ...over,
  })

  beforeEach(() => {
    store.clear()
    vi.mocked(saveTurnRemote).mockClear()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
  })

  it('survives a sync, since the server does not store it', async () => {
    saveTurn(turn({ talk }))
    await Promise.resolve()
    vi.mocked(listTurns).mockResolvedValueOnce([turn()])
    const [found] = await syncTurns('near')
    expect(found?.talk).toEqual(talk)
  })
})

describe('reveal order', () => {
  it('keeps frames in order and lands final cards after the last talk item', () => {
    let last = 0
    const shown: number[] = []
    for (const elapsed of [100, 100, 100, 3000, 3000]) {
      last = planTalkReveal(last, elapsed)
      shown.push(last)
    }
    expect(shown).toEqual([...shown].sort((x, y) => x - y))
    const firstCard = planFinalReveal(last, 3000)
    const secondCard = planFinalReveal(firstCard, 3000)
    expect(firstCard).toBeGreaterThan(last)
    expect(secondCard).toBe(firstCard + 400)
  })

  it('never shows a final card before now', () => {
    expect(planFinalReveal(1000, 5000)).toBe(5000)
  })
})
