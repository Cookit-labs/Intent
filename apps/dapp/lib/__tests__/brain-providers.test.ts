import { describe, expect, it } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { createBrain } from '../agents/brains/openai-compatible'
import { OPENROUTER_MODELS, PROVIDERS, modelFor, resolveModel } from '../agents/brains/providers'
import { parseIntent } from '../parse-intent'

/**
 * One client, three providers.
 *
 * DeepSeek, Groq and a local Ollama daemon all speak the OpenAI
 * chat-completions shape, which is the only reason a single implementation
 * serves all of them. What differs is configuration, and configuration is
 * exactly the kind of thing that breaks silently: a wrong endpoint or a
 * `strict: true` sent to a provider that rejects unknown fields fails every
 * agent on that provider, and the panel shows four cards reading "did not
 * respond" with nothing to say why.
 *
 * So each provider's outbound request is captured and asserted here, with no
 * network touched.
 */

const market: MarketContext = {
  asOf: new Date().toISOString(),
  prices: { XLM: 0.18, USDC: 1 },
  venues: [{ id: 'soroswap', name: 'Soroswap', category: 'dex' }],
  volatilityHint: 'normal',
  gasHint: 'cheap',
}

const request: ProposalRequest = {
  intent: parseIntent('Swap 20 USDC to XLM'),
  agent: 'groq:qwen/qwen3.8-27b',
  seat: 0,
  market,
  chain: 'stellar',
}

interface Captured {
  url: string
  body: {
    model: string
    tool_choice: string
    tools: { function: { strict?: boolean } }[]
  }
  headers: Record<string, string>
}

/** Records the request and answers with a well-formed but unusable reply. */
function capture(into: Captured[]): typeof fetch {
  return ((url: string, init: RequestInit) => {
    into.push({
      url,
      body: JSON.parse(String(init.body)) as Captured['body'],
      headers: init.headers as Record<string, string>,
    })
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: {} }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
}

describe('each provider is called at its own endpoint', () => {
  it('sends DeepSeek to its beta endpoint with a strict tool schema', async () => {
    const seen: Captured[] = []
    const brain = createBrain({
      provider: 'deepseek',
      apiKey: 'sk-test',
      fetchImpl: capture(seen),
    })
    await brain.propose(request)

    expect(seen[0]?.url).toBe('https://api.deepseek.com/beta/chat/completions')
    expect(seen[0]?.body.tools[0]?.function.strict).toBe(true)
    expect(seen[0]?.headers['Authorization']).toBe('Bearer sk-test')
  })

  it('sends Groq to its OpenAI-compatible endpoint without strict tools', async () => {
    // Groq rejects the strict field. Sending it fails the request outright,
    // and every response is validated application-side regardless.
    const seen: Captured[] = []
    const brain = createBrain({ provider: 'groq', apiKey: 'gsk-test', fetchImpl: capture(seen) })
    await brain.propose(request)

    expect(seen[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(seen[0]?.body.tools[0]?.function.strict).toBe(false)
    expect(seen[0]?.body.model).toBe(PROVIDERS.groq.defaultModel)
  })

  it('sends OpenRouter to its OpenAI-compatible endpoint without strict tools', async () => {
    // OpenRouter fronts every free model here under one key and passes the
    // request through to whichever lab serves it; `strict` is not in the
    // shape they all accept.
    const seen: Captured[] = []
    const brain = createBrain({
      provider: 'openrouter',
      apiKey: 'or-test',
      fetchImpl: capture(seen),
    })
    await brain.propose(request)

    expect(seen[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(seen[0]?.body.tools[0]?.function.strict).toBe(false)
    expect(seen[0]?.body.model).toBe('inclusionai/ling-3.0-flash-fin:free')
  })

  it('needs no key for a local daemon', async () => {
    // A local model is configured by being chosen. Whether it is running is a
    // request-time failure, which is a different thing from a missing key and
    // must not be reported as one.
    const seen: Captured[] = []
    const brain = createBrain({ provider: 'ollama', fetchImpl: capture(seen) })

    expect(brain.isConfigured()).toBe(true)
    await brain.propose(request)
    expect(seen[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('never forces a tool choice', async () => {
    // DeepSeek's thinking mode rejects a forced choice outright — "Thinking
    // mode does not support this tool_choice" — and Ollama ignores the field.
    // The brief instructs the model to call the tool instead.
    for (const provider of ['deepseek', 'groq', 'ollama', 'openrouter'] as const) {
      const seen: Captured[] = []
      await createBrain({ provider, apiKey: 'k', fetchImpl: capture(seen) }).propose(request)
      expect(seen[0]?.body.tool_choice).toBe('auto')
    }
  })

  it('names the model it will call, for display beside the agent', async () => {
    const brain = createBrain({ provider: 'groq', apiKey: 'gsk-test', model: 'llama-3.3-70b' })
    expect(brain.model).toBe('llama-3.3-70b')
    expect(brain.id).toBe('groq')
  })
})

describe('spend is reported per provider', () => {
  it('charges nothing for a free provider', async () => {
    const brain = createBrain({
      provider: 'groq',
      apiKey: 'gsk-test',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: {} }],
              usage: { prompt_tokens: 5000, completion_tokens: 2000 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )) as unknown as typeof fetch,
    })
    const outcome = await brain.propose(request)
    expect(outcome.meta.costUsd).toBe(0)
    expect(outcome.meta.provider).toBe('groq')
  })
})

describe('OpenRouter models can be named by alias', () => {
  // Full ids are long and punctuated (`inclusionai/ling-3.0-flash-fin:free`),
  // and AGENT_BRAINS lists one per agent. A short name per curated model keeps
  // that line readable; anything not in the table is passed through as an id.
  it('expands a curated alias to its catalogue id', () => {
    expect(resolveModel('openrouter', 'ling-fin')).toBe('inclusionai/ling-3.0-flash-fin:free')
    expect(resolveModel('openrouter', 'nemotron-super')).toBe(
      'nvidia/nemotron-3-super-120b-a12b:free'
    )
  })

  it('passes an unknown name through as a raw model id', () => {
    expect(resolveModel('openrouter', 'google/gemma-4-31b-it:free')).toBe(
      'google/gemma-4-31b-it:free'
    )
  })

  it('leaves other providers alone', () => {
    expect(resolveModel('groq', 'ling-fin')).toBe('ling-fin')
  })

  it('accepts an alias in the per-provider model override', () => {
    const env = { ...process.env, OPENROUTER_MODEL: 'gemma-4' }
    expect(modelFor('openrouter', env)).toBe('google/gemma-4-26b-a4b-it:free')
  })

  it('curates five models, each from a different lab', () => {
    const ids = Object.values(OPENROUTER_MODELS)
    expect(ids).toHaveLength(5)
    const labs = new Set(ids.map((id) => id.split('/')[0]))
    expect(labs.size).toBe(5)
  })
})
