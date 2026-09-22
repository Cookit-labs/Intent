import { describe, expect, it } from 'vitest'

import { agentGradient, agentKey, agentName, prettyModel } from '../agents/identity'

/**
 * An agent is a model. Its key, name and colour all derive from
 * provider + model and nothing else, so the same model is the same agent in
 * every race, every history row, and every deploy.
 */

describe('agentKey', () => {
  it('is provider, colon, resolved model id', () => {
    expect(agentKey('openrouter', 'inclusionai/ling-3.0-flash-fin:free')).toBe(
      'openrouter:inclusionai/ling-3.0-flash-fin:free'
    )
    expect(agentKey('deepseek', 'deepseek-v4-flash')).toBe('deepseek:deepseek-v4-flash')
  })

  it('makes the same model on two providers two agents', () => {
    expect(agentKey('groq', 'qwen/qwen3.8-27b')).not.toBe(
      agentKey('openrouter', 'qwen/qwen3.8-27b')
    )
  })
})

describe('prettyModel', () => {
  it('drops the vendor prefix and the tag', () => {
    expect(prettyModel('qwen/qwen3.8-27b')).toBe('Qwen3.8 27B')
    expect(prettyModel('qwen3.5:latest')).toBe('Qwen3.5')
    expect(prettyModel('inclusionai/ling-3.0-flash-fin:free')).toBe('Ling 3.0 Flash Fin')
  })

  it('upper-cases version and size tokens', () => {
    expect(prettyModel('deepseek-v4-flash')).toBe('Deepseek V4 Flash')
    expect(prettyModel('nvidia/nemotron-3-super-120b-a12b:free')).toBe('Nemotron 3 Super 120B A12B')
  })
})

describe('agentName', () => {
  it('prefers the curated display name', () => {
    expect(agentName('deepseek', 'deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(agentName('openrouter', 'inclusionai/ling-3.0-flash-fin:free')).toBe(
      'Ling 3.0 Flash Fin'
    )
  })

  it('falls back to the prettified id for a raw model', () => {
    expect(agentName('openrouter', 'google/gemma-4-31b-it:free')).toBe('Gemma 4 31B It')
  })
})

describe('agentGradient', () => {
  it('is a CSS gradient that is stable for a key', () => {
    const a = agentGradient('deepseek:deepseek-v4-flash')
    expect(a).toMatch(/^linear-gradient\(135deg, hsl\(\d+ 35% 55%\), hsl\(\d+ 30% 70%\)\)$/)
    expect(agentGradient('deepseek:deepseek-v4-flash')).toBe(a)
  })

  it('differs between keys', () => {
    expect(agentGradient('deepseek:deepseek-v4-flash')).not.toBe(
      agentGradient('groq:qwen/qwen3.8-27b')
    )
  })
})
