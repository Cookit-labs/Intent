import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which model answers for each agent, and — more importantly — what happens
 * when none can.
 *
 * A mock brain used to stand in for a missing key, so a misconfigured
 * deployment ran four agents reciting canned text. The registry now returns
 * nothing, and the route turns nothing into a message the user reads.
 *
 * The rest of this file pins the per-agent assignment. Four calls to one model
 * are four samples of one mind and they converge; different models disagree
 * for real reasons, and the disagreement is what the competition is for. So
 * the mapping has to be configurable, and a typo in that configuration must
 * cost variety rather than an agent.
 *
 * Modules are reset between cases because each brain reads its key once, at
 * load. A registry imported fresh over stale brains would report the
 * environment as it was the first time, not as it is now.
 */

const KEYS = ['DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'AGENT_BRAINS'] as const

async function registry(): Promise<typeof import('../agents/registry')> {
  return import('../agents/registry')
}

describe('getAgentBrains', () => {
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

  it('returns nothing rather than a stand-in when no provider is configured', async () => {
    const { getAgentBrains } = await registry()
    expect(getAgentBrains()).toBeUndefined()
  })

  it('gives every agent a brain when one provider is configured', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getAgentBrains } = await registry()
    const brains = getAgentBrains()
    expect(Object.keys(brains ?? {})).toHaveLength(4)
    expect(Object.values(brains ?? {}).every((b) => b.id === 'deepseek')).toBe(true)
  })

  it('spreads the configured providers across the agents by default', async () => {
    // The point of more than one key: the four agents stop being four samples
    // of the same model.
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    const { getAgentBrains } = await registry()
    const ids = Object.values(getAgentBrains() ?? {}).map((b) => b.id)
    expect(new Set(ids).size).toBeGreaterThan(1)
  })

  it('honours an explicit per-agent assignment', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'groq,deepseek,groq,deepseek'
    const { getAgentBrains } = await registry()
    const brains = getAgentBrains()
    expect(brains?.twap.id).toBe('groq')
    expect(brains?.momentum.id).toBe('deepseek')
    expect(brains?.arbitrage.id).toBe('groq')
    expect(brains?.shadow.id).toBe('deepseek')
  })

  it('moves an agent off a provider that has no key rather than silencing it', async () => {
    // Groq is named but unconfigured. An agent with no brain would show as an
    // agent that did not answer, which is a worse outcome than less variety.
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'groq,groq,groq,groq'
    const { getAgentBrains } = await registry()
    expect(Object.values(getAgentBrains() ?? {}).every((b) => b.id === 'deepseek')).toBe(true)
  })

  it('treats an unrecognised provider name the same way', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'gpt5,deepseek,deepseek,deepseek'
    const { getAgentBrains } = await registry()
    expect(getAgentBrains()?.twap.id).toBe('deepseek')
  })

  it('gives agents on one provider different models when AGENT_BRAINS names them', async () => {
    // OpenRouter is one key in front of many labs. Naming the model after the
    // provider is what lets four agents share the key without sharing a mind.
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,openrouter/nemotron-super'
    const { getAgentBrains } = await registry()
    const brains = getAgentBrains()
    expect(brains?.twap.id).toBe('openrouter')
    expect(brains?.twap.model).toBe('inclusionai/ling-3.0-flash-fin:free')
    expect(brains?.momentum.model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
    expect(brains?.arbitrage.model).toBe('inclusionai/ling-3.0-flash-fin:free')
    expect(brains?.shadow.model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
  })

  it('accepts a raw catalogue id after the provider', async () => {
    // Ids contain slashes and colons of their own; everything after the first
    // slash is the model.
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/google/gemma-4-31b-it:free'
    const { getAgentBrains } = await registry()
    expect(getAgentBrains()?.twap.model).toBe('google/gemma-4-31b-it:free')
  })

  it('moves an agent off a named model whose provider has no key', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,deepseek'
    const { getAgentBrains } = await registry()
    expect(getAgentBrains()?.twap.id).toBe('deepseek')
  })

  it('names the model each agent runs on', async () => {
    // The panel shows this, so that four agents agreeing on one model reads
    // differently from four agents agreeing across three.
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getAgentBrains } = await registry()
    expect(getAgentBrains()?.twap.model).toBe('deepseek-v4-flash')
  })
})
