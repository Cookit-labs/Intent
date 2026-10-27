import { describe, expect, it } from 'vitest'

import { agentHistoryByHash, fetchAgentHistory, type AgentHistoryEntry } from '../agents/history'

function entry(overrides: Partial<AgentHistoryEntry> = {}): AgentHistoryEntry {
  return {
    raceId: 'r1',
    startedAt: '2026-10-07T10:00:00.000Z',
    tokenIn: 'XLM',
    tokenOut: 'USDC',
    sizeUsd: 42.5,
    winner: 'halcyon',
    winningModel: 'deepseek-chat',
    reasoning: 'Filling now.',
    executedHash: 'HASH1',
    ...overrides,
  }
}

describe('fetchAgentHistory', () => {
  it('returns the entries on a good response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ entries: [entry()] }), {
        status: 200,
      })) as unknown as typeof fetch
    expect(await fetchAgentHistory('GWALLET', fetchImpl)).toEqual([entry()])
  })

  it('returns an empty list, not a throw, on a bad response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await fetchAgentHistory('GWALLET', fetchImpl)).toEqual([])
  })

  it('returns an empty list when the network itself fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchAgentHistory('GWALLET', fetchImpl)).toEqual([])
  })
})

describe('agentHistoryByHash', () => {
  it('keys entries by their executed hash', () => {
    const byHash = agentHistoryByHash([entry({ executedHash: 'HASH1' })])
    expect(byHash.get('HASH1')?.reasoning).toBe('Filling now.')
  })

  it('drops an entry with no executed hash', () => {
    const byHash = agentHistoryByHash([entry({ executedHash: null })])
    expect(byHash.size).toBe(0)
  })
})
