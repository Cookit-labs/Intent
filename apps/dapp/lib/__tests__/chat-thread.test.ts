import { describe, expect, it } from 'vitest'

import { classifyFollowUp, raceContext } from '../chat/thread'

describe('classifyFollowUp', () => {
  it.each([
    'use a lower slippage',
    'make it $5',
    'only use soroswap',
    'with 0.5% slippage',
    'actually keep it small',
    'what is the fee',
  ])('reads %j as a note on the open intent', (text) => {
    expect(classifyFollowUp(text)).toBe('note')
  })

  it.each([
    'swap 5 USDC to XLM',
    'Swap $2 worth of XLM to USDC',
    'buy ETH with 100 USDC',
    'send 3 USDC to deon.xlm',
    'cash out 10 XLM to naira',
    'offramp $5 to naira',
    'supply my XLM to Blend',
  ])('reads %j as a new intent', (text) => {
    expect(classifyFollowUp(text)).toBe('new')
  })

  it('needs both a verb and a subject, so an amount alone refines', () => {
    expect(classifyFollowUp('$20')).toBe('note')
    expect(classifyFollowUp('swap them')).toBe('note')
  })
})

describe('raceContext', () => {
  const turns = [
    { id: '1', text: 'swap $2 of XLM to USDC', executed: true },
    { id: '2', text: 'buy ETH', executed: false },
    { id: '3', text: 'send 1 USDC to deon.xlm', executed: false },
  ]

  it('carries only the last two earlier turns, said as earlier and as done or not', () => {
    expect(raceContext(turns, [])).toEqual([
      'Earlier in this chat (not executed): buy ETH',
      'Earlier in this chat (not executed): send 1 USDC to deon.xlm',
    ])
  })

  it('adds the user’s notes after the earlier turns', () => {
    expect(raceContext(turns.slice(0, 1), ['use a lower slippage'])).toEqual([
      'Earlier in this chat (done): swap $2 of XLM to USDC',
      'The user added: use a lower slippage',
    ])
  })

  it('is empty for a fresh chat', () => {
    expect(raceContext([], [])).toEqual([])
  })
})
