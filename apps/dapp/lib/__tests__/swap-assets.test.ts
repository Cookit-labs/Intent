import { describe, expect, it } from 'vitest'

import {
  USDC,
  XLM,
  applySlippage,
  fromBaseUnits,
  isNative,
  resolveAsset,
  toBaseUnits,
  toCanonical,
  toHorizonParams,
} from '../swap/assets'

/**
 * Amount conversion is where a swap silently loses money, so it gets the most
 * attention here.
 */
describe('base units', () => {
  it.each([
    ['30', '300000000'],
    ['0.0000001', '1'],
    ['1', '10000000'],
    ['0', '0'],
    ['1234.5678901', '12345678901'],
  ])('converts %s XLM to %s stroops', (input, expected) => {
    expect(toBaseUnits(input)).toBe(expected)
  })

  it('round-trips without drift', () => {
    for (const v of ['30', '0.1', '999999.9999999']) {
      expect(Number(fromBaseUnits(toBaseUnits(v)))).toBeCloseTo(Number(v), 7)
    }
  })

  it('rejects more precision than a stroop can hold', () => {
    // Silently truncating here would lose the user money.
    expect(() => toBaseUnits('0.00000001')).toThrow(/decimal places/)
  })

  it.each(['-1', 'abc', '', '1.2.3'])('rejects malformed amount %j', (v) => {
    expect(() => toBaseUnits(v)).toThrow()
  })

  it('does not use floating point', () => {
    // 0.1 + 0.2 in floats is not 0.3; in stroops it is exact.
    const sum = BigInt(toBaseUnits('0.1')) + BigInt(toBaseUnits('0.2'))
    expect(sum.toString()).toBe(toBaseUnits('0.3'))
  })
})

describe('slippage', () => {
  it('reduces the amount by the tolerance', () => {
    expect(applySlippage('10000000', 100)).toBe('9900000') // 1%
  })

  it('rounds down, never up', () => {
    // Rounding up would set a floor the quoted path cannot clear, failing
    // transactions that should have succeeded.
    expect(applySlippage('7', 100)).toBe('6')
  })

  it('is a no-op at zero tolerance', () => {
    expect(applySlippage('12345', 0)).toBe('12345')
  })

  it('rejects a nonsense tolerance', () => {
    expect(() => applySlippage('100', -1)).toThrow()
    expect(() => applySlippage('100', 20_000)).toThrow()
  })
})

describe('asset resolution', () => {
  it('resolves the symbols a user may name', () => {
    expect(resolveAsset('xlm')).toEqual(XLM)
    expect(resolveAsset(' USDC ')).toEqual(USDC)
  })

  it('refuses an unknown symbol rather than guessing an issuer', () => {
    // "swap my ETH for SCAMCOIN" must fail at the boundary.
    expect(resolveAsset('SCAMCOIN')).toBeUndefined()
  })

  it('knows XLM is native and USDC is not', () => {
    expect(isNative(XLM)).toBe(true)
    expect(isNative(USDC)).toBe(false)
  })

  it('encodes assets the way Horizon expects', () => {
    expect(toHorizonParams(XLM, 'source')).toEqual({ source_asset_type: 'native' })
    expect(toHorizonParams(USDC, 'destination')).toMatchObject({
      destination_asset_type: 'credit_alphanum4',
      destination_asset_code: 'USDC',
    })
    expect(toCanonical(XLM)).toBe('native')
    expect(toCanonical(USDC)).toContain('USDC:')
  })
})
