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

/** A model that answered in plain words and never called the tool. */
function plain(content: string | null): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    )) as unknown as typeof fetch
}

const empty = {
  question: '',
  reply: '',
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
  orderStyle: 'market',
  limitPriceUsd: 0,
  amountOf: 'sent',
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
      style: 'market',
      amountOf: 'sent',
      instruction: 'Swap $5 of XLM to USDC',
      context: ['Sell: XLM', 'Receive: USDC'],
    })
  })

  it('carries a limit price and an order style the words alone would not give', async () => {
    const result = await orchestrateWithLlm(turn('get me $20 of lumens if it dips to 19 cents'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amountUsd: 20,
        amountIsUsd: true,
        amountStated: true,
        orderStyle: 'limit',
        limitPriceUsd: 0.19,
        instruction: 'Buy $20 of XLM at $0.19',
      }),
    })
    expect(result).toMatchObject({ status: 'act', style: 'limit', limitPriceUsd: 0.19 })
  })

  it('says which asset a bare quantity counts, so it is not guessed from the stablecoin', async () => {
    const sent = await orchestrateWithLlm(turn('turn 20 USDC into XLM'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amountUsd: 20,
        amountIsUsd: false,
        amountStated: true,
        amountOf: 'sent',
        instruction: 'Swap 20 USDC to XLM',
      }),
    })
    expect(sent).toMatchObject({ status: 'act', amountOf: 'sent' })

    const received = await orchestrateWithLlm(turn('buy 300 XLM'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'USDC',
        tokenOut: 'XLM',
        amountUsd: 300,
        amountIsUsd: false,
        amountStated: true,
        amountOf: 'received',
        instruction: 'Buy 300 XLM',
      }),
    })
    expect(received).toMatchObject({ status: 'act', amountOf: 'received' })
  })

  it('asks for a size when a trade names none, rather than guessing one', async () => {
    const result = await orchestrateWithLlm(turn('swap my xlm to usdc'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'act',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountStated: false,
        instruction: 'Swap XLM to USDC',
      }),
    })
    expect(result).toEqual({
      status: 'ask',
      question:
        'How much would you like to trade? A dollar amount or an amount of the asset works.',
    })
  })

  it('shows a plain-words answer as the reply when the model never called the tool', async () => {
    const result = await orchestrateWithLlm(turn('can you explain it better'), {
      ...options,
      fetchImpl: plain('Think of it as handing over one thing and getting another back.'),
    })
    expect(result).toEqual({
      status: 'help',
      reply: 'Think of it as handing over one thing and getting another back.',
    })
  })

  it('returns null when the model said nothing at all', async () => {
    expect(await orchestrateWithLlm(turn('hi'), { ...options, fetchImpl: plain(null) })).toBeNull()
    expect(await orchestrateWithLlm(turn('hi'), { ...options, fetchImpl: plain('  ') })).toBeNull()
  })

  it('uses the reply as the question when it asked in the wrong field', async () => {
    const result = await orchestrateWithLlm(turn('swap some'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'ask', reply: 'Which asset do you want to swap?' }),
    })
    expect(result).toEqual({ status: 'ask', question: 'Which asset do you want to swap?' })
  })

  it('tells the model to say nothing of its own about an unrelated message', async () => {
    let sent: { messages: { content: string }[] } | undefined
    await orchestrateWithLlm(turn('hello I think I am in love'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'out_of_scope' }, (b) => (sent = b as typeof sent)),
    })
    expect(sent?.messages[0]?.content).toMatch(/out_of_scope[^.]*leave reply empty/i)
    expect(sent?.messages[0]?.content).not.toMatch(/answer like a person/i)
  })

  it('tells the model never to leave a side of a trade empty', async () => {
    let sent: { messages: { content: string }[] } | undefined
    await orchestrateWithLlm(turn('buy 300 XLM'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'ask', question: 'Pay with what?' }, (b) => {
        sent = b as typeof sent
      }),
    })
    expect(sent?.messages[0]?.content).toMatch(/other side|ask what/i)
  })

  it('tries once more when the model answers with something unusable', async () => {
    let calls = 0
    const act = {
      ...empty,
      outcome: 'act',
      tokenIn: 'USDC',
      tokenOut: 'XLM',
      amountUsd: 20,
      amountStated: true,
      amountOf: 'sent',
      instruction: 'Swap 20 USDC to XLM',
    }
    const flaky = ((url: string, init: { body: string }) => {
      calls += 1
      return (calls === 1 ? reply({ ...empty, outcome: 'shrug' }) : reply(act))(url, init)
    }) as unknown as typeof fetch

    const result = await orchestrateWithLlm(turn('turn 20 USDC into XLM'), {
      ...options,
      fetchImpl: flaky,
    })
    expect(result?.status).toBe('act')
    expect(calls).toBe(2)
  })

  it('gives up after the second unusable answer', async () => {
    let calls = 0
    const bad = ((url: string, init: { body: string }) => {
      calls += 1
      return reply({ ...empty, outcome: 'shrug' })(url, init)
    }) as unknown as typeof fetch

    expect(await orchestrateWithLlm(turn('hi'), { ...options, fetchImpl: bad })).toBeNull()
    expect(calls).toBe(2)
  })

  it('does not retry a request that failed outright, so a timeout is not doubled', async () => {
    let calls = 0
    const down = (() => {
      calls += 1
      return Promise.reject(new Error('offline'))
    }) as unknown as typeof fetch

    expect(await orchestrateWithLlm(turn('hi'), { ...options, fetchImpl: down })).toBeNull()
    expect(calls).toBe(1)

    calls = 0
    const refused = (() => {
      calls += 1
      return Promise.resolve(new Response('{}', { status: 503 }))
    }) as unknown as typeof fetch
    expect(await orchestrateWithLlm(turn('hi'), { ...options, fetchImpl: refused })).toBeNull()
    expect(calls).toBe(1)
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

  it('answers a question about one capability from the fact sheet', async () => {
    const result = await orchestrateWithLlm(turn('can u explain sending an asset better?'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'help',
        reply: 'Send moves an asset from your wallet to another Stellar account, and you sign it.',
      }),
    })
    expect(result).toEqual({
      status: 'help',
      reply: 'Send moves an asset from your wallet to another Stellar account, and you sign it.',
    })
  })

  it('grounds the model in what Intent does on this chain, and nothing it does not', async () => {
    let stellar: { messages: { content: string }[] } | undefined
    let other: { messages: { content: string }[] } | undefined
    await orchestrateWithLlm(turn('what can I do?'), {
      ...options,
      chain: 'stellar',
      fetchImpl: reply({ ...empty, outcome: 'help' }, (b) => (stellar = b as typeof stellar)),
    })
    await orchestrateWithLlm(turn('what can I do?'), {
      ...options,
      chain: 'arc',
      fetchImpl: reply({ ...empty, outcome: 'help' }, (b) => (other = b as typeof other)),
    })
    expect(stellar?.messages[0]?.content).toMatch(/naira/i)
    expect(other?.messages[0]?.content).not.toMatch(/naira/i)
    expect(other?.messages[0]?.content).toMatch(/send/i)
  })

  it('declines a request unrelated to Intent', async () => {
    const result = await orchestrateWithLlm(turn('I would like to go jogging'), {
      ...options,
      fetchImpl: reply({
        ...empty,
        outcome: 'out_of_scope',
        reply: 'Jogging is outside what I do, but I can help you swap or send.',
      }),
    })
    expect(result).toEqual({
      status: 'out_of_scope',
      reply: 'Jogging is outside what I do, but I can help you swap or send.',
    })
  })

  it('reads a request to see the wallet as a balance, not a trade', async () => {
    const result = await orchestrateWithLlm(turn('what is in my wallet?'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'balance' }),
    })
    expect(result).toEqual({ status: 'balance' })
  })

  it('tells the model that asking for a balance is the balance outcome', async () => {
    let sent: { messages: { content: string }[] } | undefined
    await orchestrateWithLlm(turn('show my balance'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'balance' }, (b) => (sent = b as typeof sent)),
    })
    expect(sent?.messages[0]?.content).toMatch(/outcome 'balance'/i)
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
    expect(result).toEqual({ status: 'unclear', reply: 'Q5?' })
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

  it('sends the earlier conversation, and does not count it against the question cap', async () => {
    let sent: { messages: { role: string; content: string }[] } | undefined
    const history = [
      { role: 'user' as const, content: 'what can I do?' },
      { role: 'assistant' as const, content: 'You can swap, send and lend.' },
      { role: 'user' as const, content: 'and?' },
      { role: 'assistant' as const, content: 'You can also cash out to naira.' },
      { role: 'user' as const, content: 'and?' },
      { role: 'assistant' as const, content: 'And open leveraged positions.' },
      { role: 'user' as const, content: 'and?' },
      { role: 'assistant' as const, content: 'That is everything.' },
    ]
    const result = await orchestrateWithLlm(turn('explain swapping better'), {
      ...options,
      history,
      fetchImpl: reply({ ...empty, outcome: 'ask', question: 'Which part?' }, (b) => {
        sent = b as typeof sent
      }),
    })
    expect(result).toEqual({ status: 'ask', question: 'Which part?' })
    const roles = sent?.messages.map((m) => m.content) ?? []
    expect(roles.slice(1, 9)).toEqual(history.map((h) => h.content))
    expect(roles.at(-1)).toBe('explain swapping better')
  })

  it('tells the model to answer in its own words and never repeat itself', async () => {
    let sent: { messages: { content: string }[] } | undefined
    await orchestrateWithLlm(turn('explain better'), {
      ...options,
      fetchImpl: reply({ ...empty, outcome: 'help' }, (b) => (sent = b as typeof sent)),
    })
    expect(sent?.messages[0]?.content).toMatch(/never repeat/i)
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
