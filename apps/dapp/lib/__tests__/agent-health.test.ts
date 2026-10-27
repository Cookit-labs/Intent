import { describe, expect, it } from 'vitest'

import { readAgentHealth, reportFrom } from '../server/agent-health'

/**
 * Agent-health is read from the races the app already logs, not from a
 * synthetic check — see the module's own header for why. What is under
 * test: the thresholds (`reportFrom`) and the SQL shape (`readAgentHealth`
 * against a faked query function matched by statement shape).
 */

describe('reportFrom', () => {
  const window = { hours: 24, races: 10 }

  it('is insufficient_data with too few races to judge', () => {
    const r = reportFrom('mainnet', { hours: 24, races: 1 }, [], 0, 0)
    expect(r.severity).toBe('insufficient_data')
  })

  it('is ok when every agent answered', () => {
    const r = reportFrom(
      'mainnet',
      window,
      [{ agent: 'anthropic:claude-sonnet-5-5', races: 10, answered: 10 }],
      40,
      40
    )
    expect(r.severity).toBe('ok')
    expect(r.reasons).toEqual([])
  })

  it('is critical when a core agent answered zero times', () => {
    const r = reportFrom(
      'mainnet',
      window,
      [
        { agent: 'anthropic:claude-sonnet-5-5', races: 10, answered: 0 },
        { agent: 'deepseek:deepseek-v4-flash', races: 10, answered: 10 },
      ],
      10,
      20
    )
    expect(r.severity).toBe('critical')
    expect(r.reasons[0]).toContain('anthropic:claude-sonnet-5-5 answered 0 of 10')
  })

  it('is critical when nobody answered anything', () => {
    const r = reportFrom('mainnet', window, [], 0, 10)
    expect(r.severity).toBe('critical')
    expect(r.reasons[0]).toContain('no agent answered')
  })

  it('is warning when the answer rate is low but not zero', () => {
    const r = reportFrom('mainnet', window, [], 3, 10)
    expect(r.severity).toBe('warning')
  })

  it('does not flag a core agent with zero asks as dead', () => {
    // Not configured this window, not failing: races === 0 means "not asked",
    // which is a different fact from "asked and never answered".
    const r = reportFrom(
      'mainnet',
      window,
      [{ agent: 'ollama:qwen3.5', races: 0, answered: 0 }],
      10,
      10
    )
    expect(r.severity).toBe('ok')
  })

  it('leaves answerRate undefined rather than dividing by zero', () => {
    const r = reportFrom('mainnet', { hours: 24, races: 5 }, [], 0, 0)
    expect(r.answerRate).toBeUndefined()
  })
})

describe('readAgentHealth', () => {
  function fakeQuery(races: Record<string, unknown>, agents: Record<string, unknown>[]) {
    return async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('SELECT count(*) AS n')) return { rows: [races] }
      if (s.startsWith('SELECT p.agent')) return { rows: agents }
      throw new Error(`unrecognised statement: ${s}`)
    }
  }

  it('reports core-agent rows only, from the joined query', async () => {
    const query = fakeQuery({ n: '10', asked: '40', answered: '38' }, [
      { agent: 'anthropic:claude-sonnet-5-5', races: '10', answered: '10' },
      { agent: 'openrouter:google/gemma-4-26b-a4b-it:free', races: '10', answered: '2' },
    ])
    const report = await readAgentHealth(query, 'mainnet', 24, new Date('2026-10-27T00:00:00Z'))

    expect(report.coreAgents).toEqual([
      { agent: 'anthropic:claude-sonnet-5-5', races: 10, answered: 10 },
    ])
    expect(report.askedTotal).toBe(40)
    expect(report.answeredTotal).toBe(38)
    expect(report.severity).toBe('ok')
  })
})
