import { describe, expect, it } from 'vitest'

import { readOracleId, readPrice, readPrices } from '../lend/oracle'
import { BLEND_XLM } from '../lend/reserves'

/**
 * The oracle the pool actually consults, read live.
 *
 * Live rather than mocked because the thing most likely to be wrong is the
 * argument shape, not the parsing. SEP-40 takes an asset *enum* — passing a
 * bare address fails with `Error(WasmVm, InvalidAction)`, a message that names
 * nothing about arguments and is invisible to any test built on a fixture of
 * this module's own making.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const WBTC = 'CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI'
const USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

describe.skipIf(SKIP)('the live Blend oracle', () => {
  it('is named by the pool rather than hardcoded here', async () => {
    const id = await readOracleId()
    expect(id).toMatch(/^C[A-Z0-9]{55}$/)
  }, 60_000)

  it('prices XLM', async () => {
    const price = await readPrice(BLEND_XLM)

    expect(price).toBeDefined()
    expect(price?.decimals).toBe(7)
    expect(price?.price).toBeGreaterThan(BigInt(0))
  }, 60_000)

  it('reads a price far from the order book, which is the point', async () => {
    // The oracle says XLM is $0.42; testnet's book says $0.114. Both are real
    // and they answer different questions — but only this one governs whether
    // a position is liquidated, so a health factor built on the book's figure
    // would be wrong by roughly four times.
    const price = await readPrice(BLEND_XLM)
    const usd = Number(price?.price ?? 0) / 1e7

    expect(usd).toBeGreaterThan(0.2)
  }, 60_000)

  it('prices every asset the pool lends', async () => {
    const prices = await readPrices([BLEND_XLM, WBTC, USDC])

    expect(Object.keys(prices)).toHaveLength(3)
    // wBTC is worth far more per unit than XLM; a mix-up between reserves
    // would be visible here rather than in a liquidation.
    expect(prices[WBTC]?.price).toBeGreaterThan(prices[BLEND_XLM]?.price ?? BigInt(0))
  }, 90_000)

  it('carries a timestamp, so a stale price is detectable', async () => {
    const price = await readPrice(BLEND_XLM)
    expect(price?.timestamp).toBeGreaterThan(0)
  }, 60_000)
})
