import { describe, expect, it } from 'vitest'

import { fetchOrchestrate } from '../chat/orchestrate-client'
import {
  balanceMessage,
  helpMessage,
  outOfScopeMessage,
  unavailableMessage,
  unclearMessage,
} from '../chat/orchestrate-copy'

function json(body: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch
}

const turns = [{ role: 'user' as const, content: 'hi' }]

describe('fetchOrchestrate', () => {
  it('returns an act with the reading the chat will build the trade from', async () => {
    const answer = await fetchOrchestrate(
      turns,
      [],
      'stellar',
      json({
        outcome: 'act',
        action: 'swap',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        amountUsd: 5,
        amountStated: true,
        amountIsUsd: true,
        followOn: null,
        style: 'market',
        amountOf: 'sent',
        instruction: 'Swap $5 of XLM to USDC',
        context: ['Asset: XLM'],
        liveAssets: [],
      })
    )
    expect(answer).toMatchObject({
      outcome: 'act',
      instruction: 'Swap $5 of XLM to USDC',
      context: ['Asset: XLM'],
      read: {
        action: 'swap',
        tokenIn: 'XLM',
        tokenOut: 'USDC',
        style: 'market',
        amountOf: 'sent',
      },
    })
  })

  it('passes ask, help and out of scope through', async () => {
    expect(
      await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'ask', question: 'Which?' }))
    ).toEqual({
      outcome: 'ask',
      question: 'Which?',
    })
    expect(await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'help' }))).toEqual({
      outcome: 'help',
    })
    expect(
      await fetchOrchestrate(
        turns,
        [],
        'stellar',
        json({ outcome: 'help', reply: 'Send moves an asset.' })
      )
    ).toEqual({ outcome: 'help', reply: 'Send moves an asset.' })
    expect(
      await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'out_of_scope', reply: 'x' }))
    ).toEqual({ outcome: 'out_of_scope', reply: 'x' })
  })

  it('reports unavailable when the request fails or the reply is not recognisable', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(await fetchOrchestrate(turns, [], 'stellar', failing)).toEqual({
      outcome: 'unavailable',
      reason: 'unreachable',
      tokens: [],
    })
    expect(await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'nonsense' }))).toEqual({
      outcome: 'unavailable',
      reason: 'unreachable',
      tokens: [],
    })
    expect(await fetchOrchestrate(turns, [], 'stellar', json({}, 500))).toEqual({
      outcome: 'unavailable',
      reason: 'unreachable',
      tokens: [],
    })
  })

  it('sends the earlier conversation with the turns', async () => {
    let sent: { history?: unknown; turns?: unknown } | undefined
    const spy = ((_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body)
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'help' })))
    }) as unknown as typeof fetch
    const history = [
      { role: 'user' as const, content: 'what can I do?' },
      { role: 'assistant' as const, content: 'You can swap.' },
    ]
    await fetchOrchestrate(turns, [], 'stellar', spy, history)
    expect(sent?.history).toEqual(history)
    expect(sent?.turns).toEqual(turns)
  })

  it('keeps the reason and tokens the server gave', async () => {
    const answer = await fetchOrchestrate(
      turns,
      [],
      'stellar',
      json({ outcome: 'unavailable', reason: 'unknown_token', tokens: ['DOGE'] })
    )
    expect(answer).toEqual({ outcome: 'unavailable', reason: 'unknown_token', tokens: ['DOGE'] })
  })
})

describe('orchestrator copy', () => {
  it('lists what Intent can do, and only what the chain supports', () => {
    expect(helpMessage('stellar')).toMatch(/naira/i)
    expect(helpMessage('arc')).not.toMatch(/naira/i)
    expect(helpMessage('arc')).toMatch(/swap/i)
  })

  it('tells the user a request is outside Intent without running anything', () => {
    const message = outOfScopeMessage('stellar')
    expect(message).toMatch(/^That's outside what Intent does\./)
  })

  it('follows the boundary with what Intent can do, for the chain the user is on', () => {
    expect(outOfScopeMessage('stellar')).toMatch(/swap/i)
    expect(outOfScopeMessage('stellar')).toMatch(/naira/i)
    expect(outOfScopeMessage('arc')).not.toMatch(/naira/i)
  })

  it('puts a short note first when the model gave one, and does not repeat the boundary', () => {
    const message = outOfScopeMessage('stellar', 'That sounds hard.')
    expect(message.startsWith('That sounds hard.')).toBe(true)
    expect(message.match(/outside what Intent does/gi)).toHaveLength(1)
  })

  it('asks for a rephrase when the request could not be pinned down', () => {
    expect(unclearMessage()).toMatch(/rephras/i)
  })

  it('says an unrecognised token will not be traded and asks which was meant', () => {
    expect(unavailableMessage('unknown_token', ['DOGE'])).toMatch(/DOGE/)
    expect(unavailableMessage('unreadable', [])).toMatch(/can't read that right now/i)
    expect(unavailableMessage('not_tradeable', [])).toMatch(/borrowed/i)
  })

  it('passes a balance request through', async () => {
    expect(await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'balance' }))).toEqual({
      outcome: 'balance',
    })
  })
})

describe('balanceMessage', () => {
  it('lists every token the wallet holds, native first', () => {
    const text = balanceMessage({
      exists: true,
      xlm: '125.5000000',
      usdc: '40.1200000',
      hasUsdcTrustline: true,
      trustlines: {
        USDC: { balance: '40.1200000', issuer: 'GA' },
        AQUA: { balance: '9000.0000000', issuer: 'GB' },
      },
    })
    expect(text).toContain('XLM')
    expect(text).toContain('125.5')
    expect(text).toContain('USDC')
    expect(text).toContain('40.12')
    expect(text).toContain('AQUA')
    expect(text).toContain('9,000')
    expect(text.indexOf('XLM')).toBeLessThan(text.indexOf('USDC'))
  })

  it('says so when the account holds nothing or does not exist yet', () => {
    expect(
      balanceMessage({
        exists: false,
        xlm: '0',
        usdc: undefined,
        hasUsdcTrustline: false,
        trustlines: {},
      })
    ).toMatch(/not funded|no balance|empty/i)
  })

  it('says the wallet must be connected when there are no balances to read', () => {
    expect(balanceMessage(undefined)).toMatch(/connect/i)
  })
})
