import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'

import { createClaudeBrain } from '../agents/brains/anthropic'
import { createBrain } from '../agents/brains/openai-compatible'
import { ASK_TOOL } from '../agents/talk-prompts'
import { parseIntent } from '../parse-intent'

const call = { agent: 'a', system: 'sys', user: 'usr', tool: ASK_TOOL }

function replying(body: unknown, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch
}

const toolReply = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ function: { arguments: '{"to":"Jeff","question":"Why?"}' } }] },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}

function sentBody(fetchImpl: typeof fetch): Record<string, unknown> {
  const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    RequestInit,
  ]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('brain.talk', () => {
  it('sends the tool with the model reasoning off and a small limit', async () => {
    const fetchImpl = replying(toolReply)
    const brain = createBrain({
      provider: 'deepseek',
      apiKey: 'k',
      model: 'deepseek-v4-flash',
      fetchImpl,
    })
    const out = await brain.talk?.(call)

    expect(out).toMatchObject({ ok: true, args: { to: 'Jeff', question: 'Why?' } })
    const body = sentBody(fetchImpl)
    expect(body['thinking']).toEqual({ type: 'disabled' })
    expect(body['max_tokens']).toBe(400)
    expect(body['tool_choice']).toBe('auto')
    expect(body['messages']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ])
    expect((body['tools'] as { function: { name: string } }[])[0]?.function.name).toBe('ask_agent')
  })

  it("uses each provider's own setting", async () => {
    const open = replying(toolReply)
    await createBrain({ provider: 'openrouter', apiKey: 'k', model: 'x', fetchImpl: open }).talk?.(
      call
    )
    expect(sentBody(open)['reasoning']).toEqual({ enabled: false })

    const groq = replying(toolReply)
    await createBrain({ provider: 'groq', apiKey: 'k', model: 'x', fetchImpl: groq }).talk?.(call)
    expect(sentBody(groq)['max_tokens']).toBe(300)
    expect(sentBody(groq)['reasoning_effort']).toBeUndefined()

    const near = replying(toolReply)
    await createBrain({ provider: 'nearai', apiKey: 'k', model: 'x', fetchImpl: near }).talk?.(call)
    expect(sentBody(near)['reasoning_effort']).toBe('low')
    expect(sentBody(near)['max_tokens']).toBe(400)
  })

  it('reports an abort as a timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }) as unknown as typeof fetch
    const out = await createBrain({ provider: 'groq', apiKey: 'k', model: 'x', fetchImpl }).talk?.(
      call
    )
    expect(out).toMatchObject({ ok: false, error: 'timeout' })
  })

  it('reports a 429 with when it will clear', async () => {
    const fetchImpl = replying({}, { status: 429, headers: { 'retry-after': '5' } })
    const out = await createBrain({ provider: 'groq', apiKey: 'k', model: 'x', fetchImpl }).talk?.(
      call
    )
    expect(out).toMatchObject({ ok: false, error: 'rate_limited', retryAfterMs: 5000 })
  })

  it('reports a reply in prose as unusable', async () => {
    const fetchImpl = replying({ choices: [{ message: { content: 'Hello' } }] })
    const out = await createBrain({ provider: 'groq', apiKey: 'k', model: 'x', fetchImpl }).talk?.(
      call
    )
    expect(out).toMatchObject({ ok: false, error: 'invalid_schema' })
  })

  it('reports no key without calling anything', async () => {
    const fetchImpl = replying(toolReply)
    const out = await createBrain({ provider: 'groq', apiKey: '', model: 'x', fetchImpl }).talk?.(
      call
    )
    expect(out).toMatchObject({ ok: false, error: 'no_api_key' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('claude talk', () => {
  it('asks at low effort and returns the tool input', async () => {
    const create = vi.fn(async () => ({
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', name: 'ask_agent', input: { to: 'Jeff', question: 'Why?' } }],
    }))
    const client = { beta: { messages: { create } } } as unknown as Anthropic
    const out = await createClaudeBrain({ client }).talk?.(call)

    expect(out).toMatchObject({ ok: true, args: { to: 'Jeff', question: 'Why?' } })
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(body['output_config']).toEqual({ effort: 'low' })
    expect(body['max_tokens']).toBe(1024)
    expect(body['tool_choice']).toEqual({ type: 'auto' })
  })

  it('reports a refusal and no tool call as unusable', async () => {
    const reply = (stop_reason: string, content: unknown[]) => ({
      beta: {
        messages: {
          create: async () => ({
            stop_reason,
            usage: { input_tokens: 1, output_tokens: 1 },
            content,
          }),
        },
      },
    })
    const refused = createClaudeBrain({ client: reply('refusal', []) as unknown as Anthropic })
    expect(await refused.talk?.(call)).toMatchObject({ ok: false, error: 'refused' })
    const prose = createClaudeBrain({
      client: reply('end_turn', [{ type: 'text', text: 'Hi' }]) as unknown as Anthropic,
    })
    expect(await prose.talk?.(call)).toMatchObject({ ok: false, error: 'invalid_schema' })
  })
})

describe('brain.propose', () => {
  it('asks NEAR AI for low reasoning, so a first take lands inside the talk window', async () => {
    const fetchImpl = replying(toolReply)
    await createBrain({ provider: 'nearai', apiKey: 'k', model: 'x', fetchImpl }).propose({
      intent: parseIntent('swap 5 NEAR to USDC'),
      agent: 'a',
      seat: 0,
      chain: 'near',
      market: {
        asOf: new Date().toISOString(),
        prices: { NEAR: 2.6, USDC: 1 },
        venues: [{ id: 'rhea', name: 'Rhea', category: 'dex' }],
        volatilityHint: 'normal',
        gasHint: 'cheap',
      },
    })
    expect(sentBody(fetchImpl)['reasoning_effort']).toBe('low')
  })
})

describe('a race with no routes', () => {
  it('still asks for a real price estimate, which a fast model otherwise leaves at zero', async () => {
    const fetchImpl = replying(toolReply)
    await createBrain({ provider: 'nearai', apiKey: 'k', model: 'x', fetchImpl }).propose({
      intent: parseIntent('Swap 20 USDC to XLM'),
      agent: 'a',
      seat: 0,
      chain: 'stellar',
      market: {
        asOf: new Date().toISOString(),
        prices: { XLM: 0.18, USDC: 1 },
        venues: [{ id: 'soroswap', name: 'Soroswap', category: 'dex' }],
        volatilityHint: 'normal',
        gasHint: 'cheap',
      },
    })
    const context = (sentBody(fetchImpl)['messages'] as { content: string }[])
      .map((m) => m.content)
      .join('\n')
    expect(context).toMatch(/No executable routes/)
    expect(context).toMatch(/projectedAvgPriceUsd must still be your estimate, above zero/)
  })
})
