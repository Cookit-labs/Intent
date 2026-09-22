import { describe, expect, it } from 'vitest'

import { rankAgents } from '../agents/leaderboard'
import type { ChatTurn } from '../chat-history'

/**
 * The leaderboard counts what happened. A race is a turn in which the agent
 * proposed; a win is a turn it was picked as best. Nothing is invented, so
 * an agent that never raced is not on the board.
 */

function turn(
  id: string,
  winner: string | null,
  proposals: Record<string, { name: string; failed?: 'timeout' }>
): ChatTurn {
  return {
    id,
    chain: 'stellar',
    text: 'swap',
    createdAt: '2026-09-22T00:00:00.000Z',
    winner,
    proposals: Object.fromEntries(
      Object.entries(proposals).map(([key, p]) => [
        key,
        {
          key,
          name: p.name,
          avgPriceUsd: 1,
          vsOraclePct: 0,
          score: 0,
          ...(p.failed !== undefined ? { failed: p.failed } : {}),
        },
      ])
    ),
  }
}

describe('rankAgents', () => {
  it('counts races and wins per agent, most wins first', () => {
    const rows = rankAgents([
      turn('1', 'deepseek:deepseek-v4-flash', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'groq:qwen/qwen3.8-27b': { name: 'Qwen3.8 27B' },
      }),
      turn('2', 'groq:qwen/qwen3.8-27b', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'groq:qwen/qwen3.8-27b': { name: 'Qwen3.8 27B' },
      }),
      turn('3', 'deepseek:deepseek-v4-flash', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
      }),
    ])
    expect(rows).toEqual([
      {
        key: 'deepseek:deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        races: 3,
        wins: 2,
        winRate: 2 / 3,
      },
      { key: 'groq:qwen/qwen3.8-27b', name: 'Qwen3.8 27B', races: 2, wins: 1, winRate: 0.5 },
    ])
  })

  it('does not count a failed proposal as a race', () => {
    const rows = rankAgents([
      turn('1', 'twap', {
        twap: { name: 'Atlas' },
        shadow: { name: 'Halcyon', failed: 'timeout' },
      }),
    ])
    expect(rows).toEqual([{ key: 'twap', name: 'Atlas', races: 1, wins: 1, winRate: 1 }])
  })

  it('breaks a tie on wins by races, then name', () => {
    const rows = rankAgents([
      turn('1', null, { b: { name: 'Bravo' }, a: { name: 'Alpha' } }),
      turn('2', null, { b: { name: 'Bravo' } }),
    ])
    expect(rows.map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('is empty with no turns', () => {
    expect(rankAgents([])).toEqual([])
  })
})
