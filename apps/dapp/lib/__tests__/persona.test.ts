import { describe, expect, it } from 'vitest'

import { agentGradient } from '../agents/identity'
import { agentPersona } from '../agents/persona'

describe('agentPersona', () => {
  it('is stable for a key', () => {
    expect(agentPersona('deepseek:deepseek-v4-flash')).toEqual(
      agentPersona('deepseek:deepseek-v4-flash')
    )
  })

  it('shares its hue with the gradient', () => {
    const key = 'groq:qwen/qwen3.8-27b'
    const { hue } = agentPersona(key)
    expect(agentGradient(key)).toContain(`hsl(${hue} 35% 55%)`)
  })

  it('gives a line-up of agents different faces', () => {
    const keys = [
      'deepseek:deepseek-v4-flash',
      'groq:qwen/qwen3.8-27b',
      'openrouter:inclusionai/ling-3.0-flash-fin:free',
      'ollama:qwen3.5:latest',
    ]
    const faces = new Set(
      keys.map((k) => {
        const p = agentPersona(k)
        return `${p.head}-${p.eyes}-${p.mouth}-${p.antenna}`
      })
    )
    expect(faces.size).toBe(keys.length)
  })
})
