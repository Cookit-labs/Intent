import { describe, expect, it } from 'vitest'

import { intentModels } from '../llm/intent-models'

describe('intentModels', () => {
  it('puts Gemini first and keeps DeepSeek behind it', () => {
    const models = intentModels({ GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' })
    expect(models.map((m) => m.id)).toEqual(['gemini', 'deepseek'])
    expect(models[0]?.baseUrl).toContain('generativelanguage.googleapis.com')
  })

  it('takes the Gemini model name from configuration', () => {
    const [m] = intentModels({ GEMINI_API_KEY: 'g', GEMINI_INTENT_MODEL: 'gemini-x' })
    expect(m?.model).toBe('gemini-x')
  })

  it('is empty with no keys, so the callers fall back as before', () => {
    expect(intentModels({})).toEqual([])
  })
})
