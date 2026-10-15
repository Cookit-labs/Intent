import { describe, expect, it } from 'vitest'

import { fetchOrchestrate } from '../chat/orchestrate-client'
import {
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
        json({ outcome: 'help', answer: 'Send moves an asset.' })
      )
    ).toEqual({ outcome: 'help', answer: 'Send moves an asset.' })
    expect(
      await fetchOrchestrate(turns, [], 'stellar', json({ outcome: 'out_of_scope', reason: 'x' }))
    ).toEqual({ outcome: 'out_of_scope', reason: 'x' })
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
    expect(outOfScopeMessage()).toMatch(/outside what Intent does/i)
  })

  it('asks for a rephrase when the request could not be pinned down', () => {
    expect(unclearMessage()).toMatch(/rephras/i)
  })

  it('says an unrecognised token will not be traded and asks which was meant', () => {
    expect(unavailableMessage('unknown_token', ['DOGE'])).toMatch(/DOGE/)
    expect(unavailableMessage('unreadable', [])).toMatch(/can't read that right now/i)
    expect(unavailableMessage('not_tradeable', [])).toMatch(/borrowed/i)
  })
})
