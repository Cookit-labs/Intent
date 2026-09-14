import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadTurns, saveTurn, updateTurn, type BundleStep } from '../chat-history'

/**
 * Recording a bundled intent in history.
 *
 * One instruction, several transactions. Calling the row a "swap" would name
 * only its first third, and linking to a single hash would hide the rest — a
 * user tracking what happened needs every step, and for the steps that touched
 * another protocol, a way into that protocol rather than only a block explorer.
 */

const CHAIN = 'stellar'

function turn(id: string): Parameters<typeof saveTurn>[0] {
  return {
    id,
    chain: CHAIN,
    text: 'Buy $20 of XLM with USDC, then supply it to Blend',
    createdAt: new Date().toISOString(),
    proposals: {},
    winner: null,
  }
}

const STEPS: BundleStep[] = [
  {
    label: 'Swap',
    hash: 'aaa111',
    explorerUrl: 'https://stellar.expert/explorer/testnet/tx/aaa111',
  },
  {
    label: 'Supply to Blend',
    hash: 'bbb222',
    explorerUrl: 'https://stellar.expert/explorer/testnet/tx/bbb222',
    positionUrl: 'https://testnet.blend.capital/dashboard/?poolId=CCEB',
    venue: 'Blend',
  },
]

// The suite runs in node, so storage is stubbed the same way the existing
// history test stubs it.
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

describe('a bundled intent keeps every step', () => {
  it('stores each step rather than only the first hash', () => {
    saveTurn(turn('t1'))
    updateTurn('t1', { txHash: 'aaa111', bundle: STEPS })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't1')
    expect(stored?.bundle).toHaveLength(2)
  })

  it('keeps the steps in the order they executed', () => {
    // Order is meaning here: supplying before swapping would be a different
    // and impossible plan.
    saveTurn(turn('t2'))
    updateTurn('t2', { bundle: STEPS })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't2')
    expect(stored?.bundle?.[0]?.label).toBe('Swap')
    expect(stored?.bundle?.[1]?.label).toBe('Supply to Blend')
  })

  it('gives every settled step its own transaction link', () => {
    // A single link would point at one third of what happened.
    saveTurn(turn('t3'))
    updateTurn('t3', { bundle: STEPS })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't3')
    for (const step of stored?.bundle ?? []) {
      expect(step.explorerUrl).toBeDefined()
    }
    expect(new Set((stored?.bundle ?? []).map((s) => s.explorerUrl)).size).toBe(2)
  })

  it('carries a protocol link for the step that left something behind', () => {
    // The explorer proves the supply happened. The position it created lives
    // on Blend, and that is what someone tracking the bundle wants to open.
    saveTurn(turn('t4'))
    updateTurn('t4', { bundle: STEPS })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't4')
    expect(stored?.bundle?.[1]?.positionUrl).toContain('blend.capital')
    expect(stored?.bundle?.[1]?.venue).toBe('Blend')
  })

  it('does not invent a protocol link for a plain swap step', () => {
    // A swap is fully described by its transaction. A link to somewhere else
    // would imply a position that does not exist.
    saveTurn(turn('t5'))
    updateTurn('t5', { bundle: STEPS })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't5')
    expect(stored?.bundle?.[0]?.positionUrl).toBeUndefined()
  })

  it('leaves an ordinary single-transaction turn without a bundle', () => {
    // The absence of `bundle` is what tells the panel to render one link and
    // no "Bundled" label.
    saveTurn(turn('t6'))
    updateTurn('t6', { txHash: 'ccc333' })

    const stored = loadTurns(CHAIN).find((t) => t.id === 't6')
    expect(stored?.bundle).toBeUndefined()
    expect(stored?.txHash).toBe('ccc333')
  })
})
