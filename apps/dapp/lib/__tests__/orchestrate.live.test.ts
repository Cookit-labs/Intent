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

  it.each(['do something with my money', 'swap my xlm'])(
    'asks when the instruction is not clear: %s',
    async (text) => {
      const result = await ask(text)
      expect(result?.status).toBe('ask')
    },
    20_000
  )
})
