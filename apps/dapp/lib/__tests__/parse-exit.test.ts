import { describe, expect, it } from 'vitest'

import { parseStellarExit, whereReply } from '../lend/parse-exit'
import { parseCashout } from '../weave/parse-cashout'

describe('reading a way out of Blend', () => {
  it.each([
    ['withdraw 25 XLM', { kind: 'withdraw', symbol: 'XLM', amount: '25' }],
    ['Withdraw 25 XLM.', { kind: 'withdraw', symbol: 'XLM', amount: '25' }],
    ['please withdraw 1,000.5 usdc', { kind: 'withdraw', symbol: 'USDC', amount: '1000.5' }],
    ['withdraw .5 xlm from blend', { kind: 'withdraw', symbol: 'XLM', amount: '0.5' }],
    ['redeem 3 USDC from the blend pool', { kind: 'withdraw', symbol: 'USDC', amount: '3' }],
    ['take 25 XLM out of Blend', { kind: 'withdraw', symbol: 'XLM', amount: '25' }],
    ['withdraw all XLM', { kind: 'withdraw', symbol: 'XLM' }],
    ['withdraw all my usdc from blend', { kind: 'withdraw', symbol: 'USDC' }],
    ['withdraw my lumens', { kind: 'withdraw', symbol: 'XLM' }],
    ['get my USDC back out of Blend', { kind: 'withdraw', symbol: 'USDC' }],
    ['repay 5 USDC', { kind: 'repay', symbol: 'USDC', amount: '5' }],
    ['pay back all my USDC', { kind: 'repay', symbol: 'USDC' }],
    ['repay my usdc loan on blend', { kind: 'repay', symbol: 'USDC' }],
    ['take my money out of blend', { kind: 'where' }],
    ['withdraw from Blend', { kind: 'where' }],
    ['close my blend position', { kind: 'where' }],
    ['repay my loan', { kind: 'where' }],
    ['repay all', { kind: 'where' }],
  ])('%s', (text, expected) => {
    expect(parseStellarExit(text)).toEqual(expected)
  })

  it.each([
    'withdraw 5 USDC to my bank',
    'withdraw my USDC to my bank',
    'withdraw 5 dollars',
    'withdraw 0 XLM',
    'withdraw 25',
    'withdraw 25 XLM from Aquarius',
    'swap 25 XLM to USDC',
    'sell 25 XLM',
    'how do I withdraw 25 XLM from blend?',
    'cash out 5 USDC',
    'supply 25 XLM to blend',
    'repay',
  ])('leaves alone: %s', (text) => {
    expect(parseStellarExit(text)).toBeNull()
  })

  it('leaves a bank withdrawal to the cash-out reader, which still takes it', () => {
    expect(parseStellarExit('withdraw 5 USDC to my bank')).toBeNull()
    expect(parseCashout('withdraw 5 USDC to my bank')).not.toBeNull()
    expect(parseCashout('withdraw 25 XLM')).toBeNull()
  })
})

describe('saying what is in Blend', () => {
  const xlm = { display: '12.5000000', symbol: 'XLM' }
  const usdc = { display: '4.0000000', symbol: 'USDC' }

  it('lists what is there and how to take it', () => {
    const reply = whereReply({ supplied: [xlm], collateral: [usdc], borrowed: [] })
    expect(reply).toContain('12.5 XLM supplied and 4 USDC as collateral')
    expect(reply).toContain('withdraw all XLM')
  })

  it('says a loan holds collateral back', () => {
    expect(whereReply({ supplied: [], collateral: [xlm], borrowed: [usdc] })).toContain(
      'You also owe 4 USDC'
    )
  })

  it('says when there is nothing', () => {
    expect(whereReply({ supplied: [], collateral: [], borrowed: [] })).toBe(
      'You have nothing in Blend to withdraw.'
    )
  })
})
