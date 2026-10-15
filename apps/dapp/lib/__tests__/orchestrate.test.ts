import { describe, expect, it } from 'vitest'

import { orchestrateWithLlm } from '../orchestrate/orchestrate'

function reply(args: Record<string, unknown>, onBody?: (b: unknown) => void): typeof fetch {
  return ((_url: string, init: { body: string }) => {
    onBody?.(JSON.parse(init.body))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'orchestrate', arguments: JSON.stringify(args) } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
  }) as unknown as typeof fetch
}

const empty = {
  question: '',
  reason: '',
  instruction: '',
  facts: [],
  action: 'swap',
  tokenIn: '',
  tokenOut: '',
  amountUsd: 0,
  amountIsUsd: false,
  amountStated: false,
  followOn: 'none',
  followOnVenue: '',
}
const options = { apiKey: 'sk-test', allowedSymbols: ['XLM', 'USDC'] }
const turn = (content: string) => [{ role: 'user' as const, content }]

describe('orchestrateWithLlm', () => {
  it('acts on a paraphrase that names no swap verb', async () => {
    const result = await orchestrateWithLlm(turn('flip $5 of my lumens into dollars'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountUsd: 5,
        amountIsUsd: true,
        amountStated: true,
        instruction: 'Swap $5 of XLM to USDC',
        facts: ['Sell: XLM', 'Receive: USDC'],
      }),
    })
    expect(result).toEqual({
      status: 'act',
      reading: {
        action: 'swap',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountUsd: 5,
        amountIsUsd: true,
        amountStated: true,
        followOn: null,
      },
      instruction: 'Swap $5 of XLM to USDC',
      context: ['Sell: XLM', 'Receive: USDC'],
    })
  })

  it('asks one question when the meaning is unclear', async () => {
    const result = await orchestrateWithLlm(turn('do the thing with my coins'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'ask', question: 'What would you like to do?' }),
    })
    expect(result).toEqual({ status: 'ask', question: 'What would you like to do?' })
  })

  it('answers a request for what Intent can do', async () => {
    const result = await orchestrateWithLlm(turn("I'm new, what can I do here?"), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'help' }),
    })
    expect(result).toEqual({ status: 'help' })
  })

  it('declines a request unrelated to Intent', async () => {
    const result = await orchestrateWithLlm(turn('I would like to go jogging'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'out_of_scope', reason: 'Exercise, not finance.' }),
    })
    expect(result).toEqual({ status: 'out_of_scope', reason: 'Exercise, not finance.' })
  })

  it('refuses an act that names an asset the app cannot trade', async () => {
    const result = await orchestrateWithLlm(turn('swap $5 of XLM to DOGE'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'XLM',
        tokenOut: 'DOGE',
        amountUsd: 5,
        amountStated: true,
        instruction: 'Swap $5 of XLM to DOGE',
      }),
    })
    expect(result).toBeNull()
  })

  it('returns null without a key, so the caller reports it cannot read', async () => {
    expect(await orchestrateWithLlm(turn('swap'), { apiKey: '' })).toBeNull()
  })

  it('returns null for an outcome it does not know', async () => {
    const result = await orchestrateWithLlm(turn('hi'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'shrug' }),
    })
    expect(result).toBeNull()
  })

  it('stops asking after four questions and reports it could not pin the request down', async () => {
    const turns = [
      { role: 'user' as const, content: 'something' },
      { role: 'assistant' as const, content: 'Q1?' },
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'Q2?' },
      { role: 'user' as const, content: 'b' },
      { role: 'assistant' as const, content: 'Q3?' },
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'Q4?' },
      { role: 'user' as const, content: 'd' },
    ]
    const result = await orchestrateWithLlm(turns, {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'ask', question: 'Q5?' }),
    })
    expect(result).toEqual({ status: 'unclear' })
  })

  it('still acts at the cap when the last answer completed the request', async () => {
    const turns = [
      { role: 'user' as const, content: 'something' },
      { role: 'assistant' as const, content: 'Q1?' },
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'Q2?' },
      { role: 'user' as const, content: 'b' },
      { role: 'assistant' as const, content: 'Q3?' },
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'Q4?' },
      { role: 'user' as const, content: '$5 of XLM to USDC' },
    ]
    const result = await orchestrateWithLlm(turns, {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountUsd: 5,
        amountIsUsd: true,
        amountStated: true,
        instruction: 'Swap $5 of XLM to USDC',
      }),
    })
    expect(result?.status).toBe('act')
  })

  it('sends the turns and what the chat already established', async () => {
    let sent: { messages: { role: string; content: string }[] } | undefined
    await orchestrateWithLlm(turn('now send half of it to deon.xlm'), {
      ...options,
      context: ['Earlier in this chat (done): swap $2 of XLM to USDC'],
      fetchImpl: reply({ ...empty, outcome: 'ask', question: 'Which asset?' }, (b) => {
        sent = b as typeof sent
      }),
    })
    expect(sent?.messages[0]?.content).toContain('swap $2 of XLM to USDC')
    expect(sent?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'now send half of it to deon.xlm',
    })
  })

  it('keeps account numbers out of the brief', async () => {
    const result = await orchestrateWithLlm(turn('swap $5 of XLM to USDC'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountUsd: 5,
        amountIsUsd: true,
        amountStated: true,
        instruction: 'Swap $5 of XLM to USDC',
        facts: ['Asset: XLM', 'Account: 0123456789'],
      }),
    })
    expect(result?.status === 'act' && result.context).toEqual(['Asset: XLM'])
  })
})
