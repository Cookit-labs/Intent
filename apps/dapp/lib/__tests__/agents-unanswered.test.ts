import { describe, expect, it } from 'vitest'

import { SYSTEM_PROMPT, systemPromptFor } from '../agents/brief'
import { unansweredLine } from '../agents/chain-race'

describe('unansweredLine', () => {
  it('says nothing when every agent answered', () => {
    expect(unansweredLine([{ name: 'DeepSeek' }, { name: 'Qwen' }])).toBeUndefined()
    expect(unansweredLine([])).toBeUndefined()
  })

  it('names one agent and why', () => {
    expect(unansweredLine([{ name: 'DeepSeek' }, { name: 'Gemma', failed: 'rate_limited' }])).toBe(
      "1 agent didn't answer: Gemma (rate limited)."
    )
  })

  it('names several, in plain words', () => {
    expect(
      unansweredLine([
        { name: 'Gemma', failed: 'rate_limited' },
        { name: 'Laguna', failed: 'upstream_error' },
        { name: 'North', failed: 'timeout' },
        { name: 'Claude', failed: 'invalid_schema' },
      ])
    ).toBe(
      "4 agents didn't answer: Gemma (rate limited), Laguna (provider error), North (too slow), Claude (unusable answer)."
    )
  })

  it('still names an agent whose reason it does not know', () => {
    expect(unansweredLine([{ name: 'New', failed: 'something_else' }])).toBe(
      "1 agent didn't answer: New (no answer)."
    )
  })
})

describe('what an agent is told about a next step', () => {
  const brief = systemPromptFor('solana')

  it('says a later step runs on its own, so the agent does not call it unavailable', () => {
    expect(brief).toMatch(/runs that as its own next step/)
    expect(brief).toMatch(/do not say it is unavailable/i)
  })

  it('no longer claims there is no second step', () => {
    expect(brief).not.toMatch(/There is no second step/)
  })

  it('leaves Stellar as it was', () => {
    expect(systemPromptFor('stellar')).toBe(SYSTEM_PROMPT)
    expect(SYSTEM_PROMPT).not.toMatch(/runs that as its own next step/)
  })
})
