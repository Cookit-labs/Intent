import { describe, expect, it } from 'vitest'

import { assertReserveWithinCap } from '../lend/cap'
import { blendXlm } from '../lend/reserves'
import { TradeCapExceeded } from '../server/trade-cap'
import type { MarketPrice } from '../swap/price-types'

/**
 * Blend names a reserve by contract id; the cap prices by symbol. XLM is the
 * one reserve this app can price, so it is the one that can be capped, and a
 * reserve with no price is refused on mainnet rather than estimated.
 */

const asOf = '2026-10-01T00:00:00.000Z'
const table: Record<string, MarketPrice> = {
  XLM: { symbol: 'XLM', usd: 0.2, source: 'reflector', asOf },
}
const prices = () => Promise.resolve(table)

describe('capping a Blend amount', () => {
  it('passes an XLM amount under the cap and refuses one over it', async () => {
    // 200 XLM = $40; 300 XLM = $60 against a $50 cap. Base units: 7 decimals.
    await expect(
      assertReserveWithinCap(blendXlm(), '2000000000', { env: {}, network: 'mainnet', prices })
    ).resolves.toBeUndefined()
    await expect(
      assertReserveWithinCap(blendXlm(), '3000000000', { env: {}, network: 'mainnet', prices })
    ).rejects.toThrow(TradeCapExceeded)
  })

  it('refuses a reserve it cannot price', async () => {
    await expect(
      assertReserveWithinCap('CNOTAPRICEDRESERVE', '10000000', {
        env: {},
        network: 'mainnet',
        prices,
      })
    ).rejects.toThrow(/could not be valued/)
  })

  it('reads no prices on testnet', async () => {
    await expect(
      assertReserveWithinCap(blendXlm(), '99999999999999', {
        network: 'testnet',
        prices: () => Promise.reject(new Error('must not be asked')),
      })
    ).resolves.toBeUndefined()
  })
})
