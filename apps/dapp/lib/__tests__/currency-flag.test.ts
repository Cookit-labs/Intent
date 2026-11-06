import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { currencyFlag, payoutWord } from '../weave/currency-flag'

describe('currencyFlag', () => {
  it.each([
    ['NGN', '/flags/ng.svg', 'Nigeria'],
    ['KES', '/flags/ke.svg', 'Kenya'],
    ['UGX', '/flags/ug.svg', 'Uganda'],
    ['TZS', '/flags/tz.svg', 'Tanzania'],
  ])('%s has a flag file', (code, src, country) => {
    const flag = currencyFlag(code)
    expect(flag).toEqual({ src, country })
    expect(existsSync(join(__dirname, '..', '..', 'public', src))).toBe(true)
  })

  it('has nothing for a code it does not know', () => {
    expect(currencyFlag('XXX')).toBeUndefined()
  })
})

describe('payoutWord', () => {
  it('names mobile money alone', () => {
    expect(payoutWord(['mobile_money', 'mobile_money'])).toBe('mobile money provider')
  })
  it('names banks alone', () => {
    expect(payoutWord(['bank'])).toBe('bank')
  })
  it('names both when mixed', () => {
    expect(payoutWord(['bank', 'mobile_money'])).toBe('bank or mobile money')
  })
})
