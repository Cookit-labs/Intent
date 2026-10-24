import { describe, expect, it } from 'vitest'

import { agentAvatarUri } from '../agents/persona'

describe('agentAvatarUri', () => {
  it('is the same character for the same key', () => {
    expect(agentAvatarUri('deepseek:deepseek-v4-flash')).toBe(
      agentAvatarUri('deepseek:deepseek-v4-flash')
    )
  })

  it('is an SVG data URI', () => {
    expect(agentAvatarUri('groq:qwen/qwen3.8-27b')).toMatch(/^data:image\/svg\+xml;utf8,/)
  })

  it('gives a line-up of agents different characters', () => {
    const keys = [
      'deepseek:deepseek-v4-flash',
      'groq:qwen/qwen3.8-27b',
      'openrouter:inclusionai/ling-3.0-flash-fin:free',
      'ollama:qwen3.5:latest',
    ]
    expect(new Set(keys.map(agentAvatarUri)).size).toBe(keys.length)
  })
})
