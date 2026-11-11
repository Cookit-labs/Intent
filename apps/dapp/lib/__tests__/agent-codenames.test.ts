import { describe, expect, it } from 'vitest'

import type { BrainProvider } from '../agents/brain'
import { agentName, CODENAMES, modelLabel } from '../agents/identity'

/**
 * Each racing model goes by a codename, with the real model beside it in small text, so it stays
 * plain that different models compete. Chosen by the user on 11 November 2026.
 */
describe('agent codenames', () => {
  it.each([
    ['anthropic', 'claude-sonnet-5-5', 'Vega', 'Claude Sonnet 5.5'],
    ['deepseek', 'deepseek-v4-flash', 'Orion', 'DeepSeek V4 Flash'],
    ['groq', 'qwen/qwen3.8-27b', 'Lyra', 'Qwen3.8 27B'],
    ['nearai', 'z-ai/glm-5.3-flash', 'Nova', 'GLM 5.3 Flash'],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free', 'Atlas', 'Gemma 4 26B'],
    ['openrouter', 'cohere/north-mini-code:free', 'Polaris', 'North Mini Code'],
  ])('names %s %s as %s, with %s beside it', (provider, model, codename, label) => {
    expect(agentName(provider as BrainProvider, model)).toBe(codename)
    expect(modelLabel(model)).toBe(label)
  })

  it('gives every codename to one model only', () => {
    const names = Object.values(CODENAMES)
    expect(new Set(names).size).toBe(names.length)
  })

  it('falls back to the model name for a model with no codename', () => {
    expect(agentName('deepseek', 'deepseek-v4-pro')).toBe('DeepSeek V4 Pro')
    expect(modelLabel('mistral/some-new-model-7b')).toBe('Some New Model 7B')
  })
})
