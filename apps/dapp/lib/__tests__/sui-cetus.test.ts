import { describe, expect, it } from 'vitest'

import {
  cetusOverlay,
  judgeRoute,
  MAX_PRICE_IMPACT,
  MAX_VALUE_LOSS,
  SLIPPAGE_BPS,
} from '../chains/sui/cetus-rules'
import { ChainActionRefused } from '../chains/types'
import { SUI_TOKENS } from '../chains/sui/tokens'

const [SUI, USDC] = [
  SUI_TOKENS.find((t) => t.symbol === 'SUI'),
  SUI_TOKENS.find((t) => t.symbol === 'USDC'),
] as const
if (SUI === undefined || USDC === undefined) throw new Error('token list changed')

const FINE = {
  requestedIn: '100000000',
  amountIn: '100000000',
  amountOut: '111826266892',
  deviationRatio: '0.00000921',
  tokenIn: USDC,
  tokenOut: SUI,
  priceIn: 1,
  priceOut: 0.8954,
}

describe('judging a route before it can reach a wallet', () => {
  it('passes a healthy route', () => {
    expect(() => judgeRoute(FINE)).not.toThrow()
  })

  it('has limits no looser than the brief', () => {
    expect(MAX_PRICE_IMPACT).toBeLessThanOrEqual(0.03)
    expect(MAX_VALUE_LOSS).toBeLessThanOrEqual(0.05)
    expect(SLIPPAGE_BPS).toBeLessThanOrEqual(100)
  })

  it('refuses price impact over 3%, whichever way the API signs it', () => {
    for (const deviationRatio of ['0.0301', '-0.0301']) {
      expect(() => judgeRoute({ ...FINE, deviationRatio })).toThrow(ChainActionRefused)
      expect(() => judgeRoute({ ...FINE, deviationRatio })).toThrow(/move the price/)
    }
  })

  it('refuses a price impact it cannot read', () => {
    expect(() => judgeRoute({ ...FINE, deviationRatio: 'nope' })).toThrow(ChainActionRefused)
    expect(() => judgeRoute({ ...FINE, deviationRatio: undefined })).toThrow(ChainActionRefused)
  })

  it('refuses the FDUSD case: a $100K route that returns $28.5K', () => {
    const fdusd = { symbol: 'FDUSD', id: '0xf::fdusd::FDUSD', decimals: 6 }
    expect(() =>
      judgeRoute({
        ...FINE,
        requestedIn: '100000000000',
        amountIn: '100000000000',
        amountOut: '28532000000',
        deviationRatio: '0.001',
        tokenOut: fdusd,
        priceOut: 1,
      })
    ).toThrow(/worse than/)
  })

  it('refuses just over 5% worse and allows just under', () => {
    const atValue = (dollars: number): Parameters<typeof judgeRoute>[0] => ({
      ...FINE,
      requestedIn: '100000000',
      amountIn: '100000000',
      tokenOut: USDC,
      amountOut: String(dollars * 1e6),
      priceOut: 1,
    })
    expect(() => judgeRoute(atValue(94.9))).toThrow(ChainActionRefused)
    expect(() => judgeRoute(atValue(95.1))).not.toThrow()
  })

  it('refuses when either side has no live price, rather than guessing', () => {
    expect(() => judgeRoute({ ...FINE, priceOut: undefined })).toThrow(/live price/)
    expect(() => judgeRoute({ ...FINE, priceIn: undefined })).toThrow(/live price/)
  })

  it('refuses a route quoted for less than was asked', () => {
    expect(() => judgeRoute({ ...FINE, amountIn: '50000000' })).toThrow(/amount/)
  })

  it('refuses a route that pays nothing', () => {
    expect(() => judgeRoute({ ...FINE, amountOut: '0' })).toThrow(ChainActionRefused)
  })
})

describe('the overlay fee', () => {
  const RECEIVER = '0x1111111111111111111111111111111111111111111111111111111111111111'

  it('is off unless a receiver is set', () => {
    expect(cetusOverlay({})).toBeUndefined()
    expect(cetusOverlay({ CETUS_OVERLAY_FEE_BPS: '10' })).toBeUndefined()
  })

  it('is off with a receiver but no rate, so nobody is charged by default', () => {
    expect(cetusOverlay({ CETUS_OVERLAY_FEE_RECEIVER: RECEIVER })).toBeUndefined()
  })

  it('is off when the receiver is not an address', () => {
    expect(
      cetusOverlay({ CETUS_OVERLAY_FEE_RECEIVER: 'nope', CETUS_OVERLAY_FEE_BPS: '10' })
    ).toBeUndefined()
  })

  it('is off when the rate is out of range or not a whole number', () => {
    for (const CETUS_OVERLAY_FEE_BPS of ['0', '-1', '101', '1.5', 'x']) {
      expect(
        cetusOverlay({ CETUS_OVERLAY_FEE_RECEIVER: RECEIVER, CETUS_OVERLAY_FEE_BPS })
      ).toBeUndefined()
    }
  })

  it('reads a valid receiver and rate', () => {
    expect(
      cetusOverlay({ CETUS_OVERLAY_FEE_RECEIVER: RECEIVER, CETUS_OVERLAY_FEE_BPS: '10' })
    ).toEqual({ receiver: RECEIVER, bps: 10 })
  })
})
