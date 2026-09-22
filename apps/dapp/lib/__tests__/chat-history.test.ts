import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearTurns, loadTurns, saveTurn, updateTurn, type ChatTurn } from '../chat-history'

/**
 * Conversations are kept so a reload does not erase what the agents said.
 *
 * The chat held everything in component state: refreshing wiped the reasoning,
 * and composing a second intent overwrote the first.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  })
})

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 'turn-1',
    chain: 'stellar',
    text: 'Swap $50 of USDC to XLM',
    createdAt: new Date().toISOString(),
    proposals: {},
    winner: 'shadow',
    ...over,
  }
}

describe('chat history', () => {
  it('keeps a conversation across reads', () => {
    saveTurn(turn())
    const [first] = loadTurns('stellar')
    expect(first?.text).toBe('Swap $50 of USDC to XLM')
    expect(first?.winner).toBe('shadow')
  })

  it('scopes turns to their chain', () => {
    // An intent belongs to the network it was placed on; a Stellar wallet
    // cannot act on an Arc conversation.
    saveTurn(turn({ id: 'a', chain: 'stellar' }))
    saveTurn(turn({ id: 'b', chain: 'arc' }))

    expect(loadTurns('stellar').map((t) => t.id)).toEqual(['a'])
    expect(loadTurns('arc').map((t) => t.id)).toEqual(['b'])
  })

  it('lists newest first', () => {
    saveTurn(turn({ id: 'older' }))
    saveTurn(turn({ id: 'newer' }))
    expect(loadTurns('stellar').map((t) => t.id)).toEqual(['newer', 'older'])
  })

  it('replaces a turn rather than duplicating it', () => {
    saveTurn(turn({ id: 'same' }))
    saveTurn(turn({ id: 'same', winner: 'twap' }))

    const all = loadTurns('stellar')
    expect(all).toHaveLength(1)
    expect(all[0]?.winner).toBe('twap')
  })

  it('attaches an outcome after the fact', () => {
    // The competition finishes long before the signature does.
    saveTurn(turn({ id: 'x' }))
    updateTurn('x', { txHash: 'a'.repeat(64), executedBy: 'momentum' })

    const [found] = loadTurns('stellar')
    expect(found?.txHash).toBe('a'.repeat(64))
    expect(found?.executedBy).toBe('momentum')
  })

  it('ignores an update for a turn that is not there', () => {
    saveTurn(turn({ id: 'x' }))
    updateTurn('missing', { txHash: 'b'.repeat(64) })
    expect(loadTurns('stellar')).toHaveLength(1)
  })

  it('clears only the chain asked for', () => {
    saveTurn(turn({ id: 'a', chain: 'stellar' }))
    saveTurn(turn({ id: 'b', chain: 'arc' }))

    clearTurns('stellar')

    expect(loadTurns('stellar')).toHaveLength(0)
    expect(loadTurns('arc')).toHaveLength(1)
  })

  it('survives unreadable storage', () => {
    // Private-mode browsers throw on access. The session should still work.
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

    expect(() => saveTurn(turn())).not.toThrow()
    expect(loadTurns('stellar')).toEqual([])
  })
})

/**
 * A reopened conversation must be usable, not just readable.
 *
 * Selecting a past intent used to resubmit its text, which started a fresh
 * competition and produced different answers — the recorded conversation was
 * never actually restored.
 */
describe('a stored turn carries everything needed to reopen it', () => {
  it('keeps each agent route, so a reopened turn can still be signed', () => {
    const routes = { shadow: { destAmount: '1288345201' }, twap: { destAmount: '1288345201' } }
    saveTurn(turn({ id: 'r', routesByAgent: routes }))

    const [found] = loadTurns('stellar')
    expect(found?.routesByAgent).toEqual(routes)
  })

  it('keeps the proposals as recorded rather than rebuilding them', () => {
    const proposals = {
      shadow: {
        key: 'shadow',
        name: 'Shadow',
        avgPriceUsd: 0.3881,
        vsOraclePct: 0.05,
        score: 93,
        reasoning: 'Priced 2 paths.',
      },
    }
    saveTurn(turn({ id: 'p', proposals }))

    const [found] = loadTurns('stellar')
    expect(found?.proposals['shadow']?.reasoning).toBe('Priced 2 paths.')
    expect(found?.proposals['shadow']?.avgPriceUsd).toBe(0.3881)
  })

  it('does not lose the outcome when the turn is read back', () => {
    saveTurn(turn({ id: 'o' }))
    updateTurn('o', { executedBy: 'shadow', txHash: 'c'.repeat(64) })

    const [found] = loadTurns('stellar')
    expect(found?.executedBy).toBe('shadow')
    expect(found?.txHash).toBe('c'.repeat(64))
    // The recorded reasoning survives alongside it.
    expect(found?.winner).toBe('shadow')
  })
})

/**
 * Starting a new intent must not cost you the last one.
 *
 * The chat holds one conversation at a time, so composing a second intent
 * replaces what is on screen. That is fine only if the first is already
 * recorded and still reopenable — otherwise "new conversation" quietly means
 * "discard the previous one", which is the opposite of a history.
 */
describe('conversations accumulate rather than replace', () => {
  it('keeps every intent as new ones are started', () => {
    saveTurn(turn({ id: 'first', text: 'Swap 50 USDC to XLM' }))
    saveTurn(turn({ id: 'second', text: 'Buy 300 XLM below $0.30' }))
    saveTurn(turn({ id: 'third', text: 'Sell 1000 XLM above $0.42' }))

    const all = loadTurns('stellar')
    expect(all).toHaveLength(3)
    // Newest first, so the most recent work is reachable without scrolling.
    expect(all.map((t) => t.id)).toEqual(['third', 'second', 'first'])
  })

  it('leaves an unexecuted conversation reopenable', () => {
    // A competition that ran and was never signed is still worth keeping: the
    // reasoning is the substance, and the user may come back to it.
    saveTurn(turn({ id: 'unsigned', winner: 'shadow' }))
    saveTurn(turn({ id: 'next' }))

    const found = loadTurns('stellar').find((t) => t.id === 'unsigned')
    expect(found?.winner).toBe('shadow')
    expect(found?.txHash).toBeUndefined()
  })

  it('does not disturb an earlier turn when a later one settles', () => {
    saveTurn(turn({ id: 'older', winner: 'twap' }))
    saveTurn(turn({ id: 'newer' }))
    updateTurn('newer', { txHash: 'f'.repeat(64) })

    const all = loadTurns('stellar')
    expect(all.find((t) => t.id === 'older')?.txHash).toBeUndefined()
    expect(all.find((t) => t.id === 'older')?.winner).toBe('twap')
    expect(all.find((t) => t.id === 'newer')?.txHash).toBe('f'.repeat(64))
  })
})
