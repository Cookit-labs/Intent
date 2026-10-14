import { describe, expect, it } from 'vitest'

import { clarifyWithLlm } from '../clarify/clarify'

function reply(args: Record<string, unknown>): typeof fetch {
  return (() =>
    Promise.resolve(
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
    )) as unknown as typeof fetch
}

const base = { question: '', facts: [], bankName: '', accountNumber: '' }
const options = { apiKey: 'sk-test' }
const swap = [{ role: 'user' as const, content: 'Swap $5 worth of XLM to naira' }]

describe('clarifyWithLlm', () => {
  it('asks when something is missing', async () => {
    const result = await clarifyWithLlm(swap, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ask',
        question: 'Which bank should receive the naira?',
      }),
    })
    expect(result).toEqual({ status: 'ask', question: 'Which bank should receive the naira?' })
  })

  it('is ready with a shared brief that leaves the account number out', async () => {
    const result = await clarifyWithLlm(swap, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ready',
        facts: ['Destination: Nigerian naira', 'Bank: GTBank'],
        bankName: 'GTBank',
        accountNumber: '0123456789',
      }),
    })
    expect(result).toEqual({
      status: 'ready',
      context: ['Destination: Nigerian naira', 'Bank: GTBank'],
      payout: { bankName: 'GTBank', accountNumber: '0123456789' },
    })
    expect(JSON.stringify(result && 'context' in result ? result.context : [])).not.toContain(
      '0123456789'
    )
  })

  it('refuses an account number that is not ten digits, whatever the model says', async () => {
    const result = await clarifyWithLlm(swap, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ready',
        facts: ['Destination: Nigerian naira'],
        bankName: 'GTBank',
        accountNumber: '12345',
      }),
    })
    expect(result?.status).toBe('ask')
    expect(result && 'question' in result ? result.question : '').toMatch(/10 digits/)
  })

  it('drops an account number the model leaked into the shared facts', async () => {
    const result = await clarifyWithLlm(swap, {
      ...options,
      fetchImpl: reply({
        ...base,
        status: 'ready',
        facts: ['Destination: Nigerian naira', 'Account: 0123456789'],
        bankName: 'GTBank',
        accountNumber: '0123456789',
      }),
    })
    expect(result && 'context' in result ? result.context : []).toEqual([
      'Destination: Nigerian naira',
    ])
  })

  it('has no payout when no bank was involved', async () => {
    const result = await clarifyWithLlm(swap, {
      ...options,
      fetchImpl: reply({ ...base, status: 'ready', facts: ['Amount: $5'] }),
    })
    expect(result).toEqual({ status: 'ready', context: ['Amount: $5'] })
  })

  it('answers null when it cannot help, so the caller carries on without it', async () => {
    expect(await clarifyWithLlm(swap, {})).toBeNull()
    expect(
      await clarifyWithLlm(swap, {
        ...options,
        fetchImpl: (() =>
          Promise.resolve(new Response('{}', { status: 500 }))) as unknown as typeof fetch,
      })
    ).toBeNull()
    expect(
      await clarifyWithLlm(swap, {
        ...options,
        fetchImpl: reply({ ...base, status: 'ask', question: '' }),
      })
    ).toBeNull()
  })

  it('stops asking after five questions rather than interrogating the user', async () => {
    const long = Array.from({ length: 5 }, (_, i) => [
      { role: 'assistant' as const, content: `q${i}` },
      { role: 'user' as const, content: `a${i}` },
    ]).flat()
    expect(
      await clarifyWithLlm([...swap, ...long], {
        ...options,
        fetchImpl: reply({ ...base, status: 'ask', question: 'One more?' }),
      })
    ).toBeNull()
  })
})
