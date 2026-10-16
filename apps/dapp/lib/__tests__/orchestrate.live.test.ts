import { describe, expect, it } from 'vitest'

import { intentModels } from '../llm/intent-models'
import { orchestrateWithLlm } from '../orchestrate/orchestrate'

/**
 * The orchestrator against a real model.
 *
 * Live because the point of it is meaning rather than wording, and a mocked
 * reply can only prove the plumbing. Skipped without a model key, and with the
 * other live tests when SKIP_LIVE=1.
 */

const SKIP = process.env['SKIP_LIVE'] === '1' || intentModels().length === 0
const options = { allowedSymbols: ['XLM', 'USDC', 'CETES'], allowedVenues: ['blend'] }
const ask = (content: string) => orchestrateWithLlm([{ role: 'user', content }], options)

describe.skipIf(SKIP)('the live orchestrator', () => {
  it.each([
    'flip $5 of my lumens into dollars',
    'I want to turn 20 USDC into XLM',
    'exchange $10 xlm for usdc',
    'get me some stellar lumens with 15 dollars',
  ])(
    'acts on a paraphrase: %s',
    async (text) => {
      const result = await ask(text)
      expect(result?.status).toBe('act')
    },
    20_000
  )

  it.each(['I would like to go jogging', 'what is the weather in Lagos', 'write me a poem'])(
    'declines what has nothing to do with Intent: %s',
    async (text) => {
      const result = await ask(text)
      expect(result?.status).toBe('out_of_scope')
    },
    20_000
  )

  it.each(["I'm a new user, what can I do with Intent?", 'how does this work'])(
    'explains what Intent can do: %s',
    async (text) => {
      const result = await ask(text)
      expect(result?.status).toBe('help')
    },
    20_000
  )

  it('answers a follow-up about one capability rather than repeating the list', async () => {
    const result = await ask('can u explain this part better: send an asset to someone')
    expect(result?.status).toBe('help')
    if (result?.status === 'help') {
      expect(result.reply).toBeDefined()
      expect(result.reply?.toLowerCase()).toContain('send')
      expect(result.reply).not.toMatch(/leveraged/i)
    }
  }, 20_000)

  it('states the boundary without commenting on an unrelated message', async () => {
    const result = await ask("hello, I think I'm in love")
    expect(result?.status).toBe('out_of_scope')
    if (result?.status === 'out_of_scope') {
      // Empty, or at most a single short sentence.
      expect((result.reply ?? '').length).toBeLessThan(160)
    }
  }, 20_000)

  it('explains differently when asked to explain better, instead of repeating', async () => {
    const first = await ask('explain what you mean by swapping between assets')
    expect(first?.status).toBe('help')
    if (first?.status !== 'help' || first.reply === undefined) return

    const second = await orchestrateWithLlm(
      [{ role: 'user', content: 'can you explain it better' }],
      {
        ...options,
        history: [
          { role: 'user', content: 'explain what you mean by swapping between assets' },
          { role: 'assistant', content: first.reply },
        ],
      }
    )
    expect(second?.status).toBe('help')
    if (second?.status === 'help') {
      expect(second.reply).toBeDefined()
      expect(second.reply).not.toBe(first.reply)
    }
  }, 40_000)

  it.each(['do something with my money', 'swap my xlm'])(
    'asks when the instruction is not clear: %s',
    async (text) => {
      const result = await ask(text)
      expect(result?.status).toBe('ask')
    },
    20_000
  )
})
