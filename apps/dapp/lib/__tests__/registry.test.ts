import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which agents race, and what happens when none can.
 *
 * An agent is a model. `AGENT_BRAINS` lists them, one entry per agent, and
 * unset means every configured model. Nothing is padded to a fixed count and
 * nothing is substituted: a model the user named and did not get is a
 * warning, not a different agent wearing its name.
 *
 * Modules are reset between cases because each brain reads its key once, at
 * load.
 */

const KEYS = [
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'AGENT_BRAINS',
] as const

async function registry(): Promise<typeof import('../agents/registry')> {
  return import('../agents/registry')
}

describe('getRoster', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    for (const k of KEYS) delete process.env[k]
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const k of KEYS) {
      const was = saved[k]
      if (was === undefined) delete process.env[k]
      else process.env[k] = was
    }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns nothing rather than a stand-in when no provider is configured', async () => {
    const { getRoster } = await registry()
    expect(getRoster()).toBeUndefined()
  })

  it('fields one agent per configured provider default', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    const keys = (getRoster() ?? []).map((a) => a.key)
    expect(keys).toEqual(['deepseek:deepseek-v4-flash', 'groq:qwen/qwen3.8-27b'])
  })

  it('fields every curated OpenRouter model when that key is set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    const roster = getRoster() ?? []
    expect(roster).toHaveLength(5)
    expect(new Set(roster.map((a) => a.model)).size).toBe(5)
    expect(roster.every((a) => a.provider === 'openrouter')).toBe(true)
  })

  it('is seven agents with the three hosted keys', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect(getRoster()).toHaveLength(7)
  })

  it('never fields a local daemon unless named', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect((getRoster() ?? []).some((a) => a.provider === 'ollama')).toBe(false)
  })

  it('takes AGENT_BRAINS as the roster, in order, one entry per agent', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,deepseek'
    const { getRoster } = await registry()
    const roster = getRoster() ?? []
    expect(roster.map((a) => a.key)).toEqual([
      'openrouter:inclusionai/ling-3.0-flash-fin:free',
      'deepseek:deepseek-v4-flash',
    ])
    expect(roster[0]?.name).toBe('Ling 3.0 Flash Fin')
    expect(roster[0]?.brain.model).toBe('inclusionai/ling-3.0-flash-fin:free')
  })

  it('accepts a raw catalogue id after the provider', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/google/gemma-4-31b-it:free'
    const { getRoster } = await registry()
    expect(getRoster()?.[0]?.model).toBe('google/gemma-4-31b-it:free')
  })

  it('collapses an entry that resolves to an agent already listed', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] =
      'openrouter/ling-fin,openrouter/inclusionai/ling-3.0-flash-fin:free,openrouter'
    const { getRoster } = await registry()
    // The bare `openrouter` entry is its default model, which is ling-fin too.
    expect(getRoster()).toHaveLength(1)
    expect(console.warn).toHaveBeenCalled()
  })

  it('drops a named agent whose provider has no key, and says so', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,deepseek'
    const { getRoster } = await registry()
    expect((getRoster() ?? []).map((a) => a.provider)).toEqual(['deepseek'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OPENROUTER_API_KEY'))
  })

  it('drops an unrecognised provider name the same way', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'gpt5,deepseek'
    const { getRoster } = await registry()
    expect(getRoster()).toHaveLength(1)
  })

  it('returns nothing when every named agent is dropped', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin'
    const { getRoster } = await registry()
    expect(getRoster()).toBeUndefined()
  })

  it('gives every agent a stable colour from its key', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect(getRoster()?.[0]?.gradient).toMatch(/^linear-gradient\(/)
  })
})

describe('publicRoster', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    for (const k of KEYS) delete process.env[k]
    vi.resetModules()
  })

  afterEach(() => {
    for (const k of KEYS) {
      const was = saved[k]
      if (was === undefined) delete process.env[k]
      else process.env[k] = was
    }
    vi.resetModules()
  })

  it('exposes identity and cost, never the brain', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    const { getRoster, publicRoster } = await registry()
    const rows = publicRoster(getRoster() ?? [])
    expect(rows[0]).toEqual({
      key: 'deepseek:deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      gradient: expect.stringMatching(/^linear-gradient\(/) as string,
      provider: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-v4-flash',
      free: false,
    })
    expect(rows[1]?.free).toBe(true)
    expect(Object.keys(rows[0] ?? {})).not.toContain('brain')
  })
})
