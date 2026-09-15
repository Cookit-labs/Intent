import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bundlesByTxHash, loadTurns, saveTurn, updateTurn, type BundleStep } from '../chat-history'

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

describe('a settled trade is never lost for want of a turn', () => {
  it('creates the row when the conversation was never saved', () => {
    // The bug this covers. A turn is only written once its competition is
    // decided, and a sequence can settle before that — or after a tab switch
    // that wrote none. `updateTurn` used to return silently for an unknown id,
    // so a trade that really happened on-chain left no record anywhere.
    updateTurn(
      'never-saved',
      { txHash: 'ddd444', bundle: STEPS },
      { chain: CHAIN, text: 'Buy $20 of XLM with USDC, then supply it to Blend' }
    )

    const stored = loadTurns(CHAIN).find((t) => t.id === 'never-saved')
    expect(stored).toBeDefined()
    expect(stored?.txHash).toBe('ddd444')
    expect(stored?.bundle).toHaveLength(2)
  })

  it('keeps the text so the row is readable rather than blank', () => {
    updateTurn(
      'never-saved-2',
      { txHash: 'eee555' },
      { chain: CHAIN, text: 'Buy $20 of XLM with USDC, then supply it to Blend' }
    )

    const stored = loadTurns(CHAIN).find((t) => t.id === 'never-saved-2')
    expect(stored?.text).toContain('Buy $20 of XLM')
  })

  it('still does nothing for an unknown id with no fallback', () => {
    // Without enough to reconstruct a turn, inventing one would put a row with
    // no text and no proposals in front of the user.
    updateTurn('unknown', { txHash: 'fff666' })
    expect(loadTurns(CHAIN).find((t) => t.id === 'unknown')).toBeUndefined()
  })

  it('patches an existing turn rather than duplicating it', () => {
    saveTurn(turn('t7'))
    updateTurn('t7', { txHash: 'ggg777' }, { chain: CHAIN, text: 'ignored' })

    const matches = loadTurns(CHAIN).filter((t) => t.id === 't7')
    expect(matches).toHaveLength(1)
    // The fallback must not overwrite what the saved turn already said.
    expect(matches[0]?.text).toContain('Buy $20 of XLM')
    expect(matches[0]?.txHash).toBe('ggg777')
  })
})

describe('a ledger row can find the bundle it belonged to', () => {
  it('is reachable by the swap hash', () => {
    // The join the History tab needs. The chain records transactions, not
    // instructions: a Soroban router swap carries no memo and the supply that
    // follows is unrelated on-chain, so only the app knows they were one ask.
    saveTurn(turn('b1'))
    updateTurn('b1', { bundle: STEPS })

    const found = bundlesByTxHash(CHAIN).get('aaa111')
    expect(found?.steps).toHaveLength(2)
  })

  it('is reachable by the supply hash too', () => {
    // Opening history and landing on the supply row must identify the same
    // bundle, not leave that row orphaned.
    saveTurn(turn('b2'))
    updateTurn('b2', { bundle: STEPS })

    expect(bundlesByTxHash(CHAIN).get('bbb222')?.steps).toHaveLength(2)
  })

  it('carries the instruction as typed', () => {
    saveTurn(turn('b3'))
    updateTurn('b3', { bundle: STEPS })

    expect(bundlesByTxHash(CHAIN).get('aaa111')?.text).toContain('Buy $20 of XLM')
  })

  it('keeps the position link with the step that created one', () => {
    saveTurn(turn('b4'))
    updateTurn('b4', { bundle: STEPS })

    const steps = bundlesByTxHash(CHAIN).get('aaa111')?.steps ?? []
    expect(steps.find((s) => s.positionUrl !== undefined)?.venue).toBe('Blend')
  })

  it('ignores an ordinary turn with no bundle', () => {
    // Most turns are a single swap. Treating those as bundles would rename
    // every row in history.
    saveTurn(turn('b5'))
    updateTurn('b5', { txHash: 'solo999' })

    expect(bundlesByTxHash(CHAIN).get('solo999')).toBeUndefined()
  })

  it('does not reach across chains', () => {
    // An intent belongs to the network it was placed on.
    saveTurn(turn('b6'))
    updateTurn('b6', { bundle: STEPS })

    expect(bundlesByTxHash('arc').get('aaa111')).toBeUndefined()
  })
})
