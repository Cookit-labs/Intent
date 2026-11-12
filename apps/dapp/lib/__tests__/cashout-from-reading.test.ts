import { describe, expect, it } from 'vitest'

import { cashoutFromReading } from '../weave/parse-cashout'

const read = { action: 'offramp', tokenIn: 'USDC', amountUsd: 5.115078, amountStated: true }

describe('cashoutFromReading', () => {
  it('opens the naira form for a cash-out of USDC the model read, with the currency said', () => {
    expect(
      cashoutFromReading(read, ['Swap 5.115078 USDC to naira', 'Swap to NGN'], 'avalanche')
    ).toEqual({ kind: 'open', currency: 'NGN', amount: '5.115078' })
  })

  it('leaves the amount for the form when the person never typed it', () => {
    expect(cashoutFromReading(read, ['Swap to NGN'], 'avalanche')).toEqual({
      kind: 'open',
      currency: 'NGN',
    })
  })

  it('asks the currency when none was said', () => {
    expect(cashoutFromReading(read, ['cash out my usdc'], 'solana')).toEqual({ kind: 'ask' })
  })

  it('says nothing for any other reading', () => {
    expect(cashoutFromReading({ ...read, action: 'swap' }, ['x'], 'solana')).toBeUndefined()
    expect(cashoutFromReading({ ...read, tokenIn: 'SOL' }, ['x'], 'solana')).toBeUndefined()
  })

  it('opens the form on NEAR, open since 12 November 2026', () => {
    expect(cashoutFromReading(read, ['Swap to NGN'], 'near')).toEqual({
      kind: 'open',
      currency: 'NGN',
    })
  })

  it('opens no form on a chain whose cash-outs are closed', () => {
    expect(cashoutFromReading(read, ['Swap to NGN'], 'monad')).toEqual({
      kind: 'token',
      token: 'USDC',
    })
  })
})
