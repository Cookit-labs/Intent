import { describe, expect, it } from 'vitest'

import { clarifyWithLlm } from '../clarify/clarify'

function reply(args: Record<string, unknown>, onBody?: (b: unknown) => void): typeof fetch {
  return ((_url: string, init: { body: string }) => {
    onBody?.(JSON.parse(init.body))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'clarify', arguments: JSON.stringify(args) } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
  }) as unknown as typeof fetch
}

const base = { question: '', instruction: '', facts: [] }
const options = { apiKey: 'sk-test' }
const offramp = [{ role: 'user' as const, content: 'offramp $5' }]

describe('clarifyWithLlm', () => {
  it('asks one question when something material is missing', async () => {
    const result = await clarifyWithLlm(offramp, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ask',
        question: 'Which asset are you cashing out, XLM or USDC? It will be paid out in naira.',
      }),
    })
    expect(result).toEqual({
      status: 'ask',
      question: 'Which asset are you cashing out, XLM or USDC? It will be paid out in naira.',
    })
  })

  it('is ready with the request written out on its own and the confirmed facts', async () => {
    const result = await clarifyWithLlm(offramp, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ready',
        instruction: 'Cash out $5 worth of XLM to naira',
        facts: ['Asset: XLM', 'Payout currency: Nigerian naira'],
      }),
    })
    expect(result).toEqual({
      status: 'ready',
      instruction: 'Cash out $5 worth of XLM to naira',
      context: ['Asset: XLM', 'Payout currency: Nigerian naira'],
    })
  })

  it('sends what the chat already established, so a follow-up can be resolved', async () => {
    let sent: { messages: { role: string; content: string }[] } | undefined
    await clarifyWithLlm([{ role: 'user', content: 'now send half of it to deon.xlm' }], {
      ...options,
      context: ['Earlier in this chat (done): swap $2 of XLM to USDC'],
      fetchImpl: reply(
        { ...base, status: 'ready', instruction: 'Send 1 USDC to deon.xlm' },
        (b) => (sent = b as typeof sent)
      ),
    })
    expect(sent?.messages[0]?.content).toContain('swap $2 of XLM to USDC')
    expect(sent?.messages[1]).toEqual({
      role: 'user',
      content: 'now send half of it to deon.xlm',
    })
  })

  it('never passes an account-number-like figure on to the agents', async () => {
    const result = await clarifyWithLlm(offramp, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ready',
        instruction: 'Cash out $5 of XLM to naira',
        facts: ['Asset: XLM', 'Account: 0123456789'],
      }),
    })
    expect(result && 'context' in result ? result.context : []).toEqual(['Asset: XLM'])
  })

  it('answers null when it cannot help, so the caller runs what was typed', async () => {
    expect(await clarifyWithLlm(offramp, {})).toBeNull()
    expect(
      await clarifyWithLlm(offramp, {
        ...options,
        fetchImpl: (() =>
          Promise.resolve(new Response('{}', { status: 500 }))) as unknown as typeof fetch,
      })
    ).toBeNull()
    expect(
      await clarifyWithLlm(offramp, {
        ...options,
        fetchImpl: reply({ ...base, status: 'ask', question: '' }),
      })
    ).toBeNull()
    expect(
      await clarifyWithLlm(offramp, {
        ...options,
        fetchImpl: reply({ ...base, status: 'ready', instruction: '' }),
      })
    ).toBeNull()
  })

  it('stops asking after four questions rather than interrogating the user', async () => {
    const long = Array.from({ length: 4 }, (_, i) => [
      { role: 'assistant' as const, content: `q${i}` },
      { role: 'user' as const, content: `a${i}` },
    ]).flat()
    expect(
      await clarifyWithLlm([...offramp, ...long], {
        ...options,
        fetchImpl: reply({ ...base, status: 'ask', question: 'One more?' }),
      })
    ).toBeNull()
  })
})
