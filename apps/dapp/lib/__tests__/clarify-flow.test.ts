import { describe, expect, it, vi } from 'vitest'

import { fetchClarify } from '../chat/clarify-client'
import { fallbackInstruction, isSelfContained } from '../chat/clarify-flow'

describe('isSelfContained', () => {
  it.each([
    'swap $2 worth of XLM to USDC',
    'Swap 10 XLM to USDC',
    'buy ETH with 100 USDC',
    'cash out 20 XLM to naira',
    'send 3 USDC to deon.xlm and then swap it to XLM',
  ])('sends %j straight to the agents', (text) => {
    expect(isSelfContained(text, false)).toBe(true)
  })

  it.each([
    'offramp $5',
    'off-ramp $5 to naira',
    'swap my XLM',
    'swap 10 XLM',
    'buy some ETH',
    'cash out',
    'what is the price of XLM',
  ])('asks about %j first', (text) => {
    expect(isSelfContained(text, false)).toBe(false)
  })

  it('does not trust a request that leans on an earlier turn', () => {
    expect(isSelfContained('swap half of the 10 XLM to USDC', true)).toBe(false)
    // The same words in a fresh chat have nothing to refer to.
    expect(isSelfContained('swap half of the 10 XLM to USDC', false)).toBe(true)
  })
})

describe('fallbackInstruction', () => {
  it('is what the user said, in order', () => {
    expect(
      fallbackInstruction([
        { role: 'user', content: 'offramp $5' },
        { role: 'assistant', content: 'Which asset?' },
        { role: 'user', content: 'XLM' },
      ])
    ).toBe('offramp $5. XLM')
  })
})

describe('fetchClarify', () => {
  const json = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('returns a question, or the request written out', async () => {
    expect(
      await fetchClarify(
        [{ role: 'user', content: 'x' }],
        [],
        json({ status: 'ask', question: 'Which?' })
      )
    ).toEqual({ status: 'ask', question: 'Which?' })
    expect(
      await fetchClarify(
        [{ role: 'user', content: 'x' }],
        [],
        json({ status: 'ready', instruction: 'Swap 1 XLM to USDC', context: ['Asset: XLM', 3] })
      )
    ).toEqual({ status: 'ready', instruction: 'Swap 1 XLM to USDC', context: ['Asset: XLM'] })
  })

  it('returns null on skip, an error, or a reply it cannot read', async () => {
    const turns = [{ role: 'user' as const, content: 'x' }]
    expect(await fetchClarify(turns, [], json({ status: 'skip' }))).toBeNull()
    expect(await fetchClarify(turns, [], json({}, 500))).toBeNull()
    expect(await fetchClarify(turns, [], json({ status: 'ask', question: '' }))).toBeNull()
    expect(
      await fetchClarify(turns, [], (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch)
    ).toBeNull()
  })

  it('sends the earlier turns as context only when there are some', async () => {
    const spy = vi.fn(
      async () => new Response(JSON.stringify({ status: 'skip' }))
    ) as unknown as typeof fetch
    await fetchClarify([{ role: 'user', content: 'x' }], [], spy)
    await fetchClarify([{ role: 'user', content: 'x' }], ['Earlier: y'], spy)
    const calls = (spy as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls
    expect(JSON.parse(calls[0]?.[1].body ?? '{}')).not.toHaveProperty('context')
    expect(JSON.parse(calls[1]?.[1].body ?? '{}')).toHaveProperty('context', ['Earlier: y'])
  })
})
