import { getConfig, getPools } from '@naviprotocol/lending'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { dryRunChange } from '../chains/sui/lending-calls'
import { naviVenue } from '../chains/sui/navi'
import {
  NAVI_INCENTIVE_V2,
  NAVI_INCENTIVE_V3,
  NAVI_ORACLE_CONFIG,
  NAVI_ORACLE_PACKAGE,
  NAVI_PRICE_ORACLE,
  NAVI_STORAGE,
  NAVI_SUPRA_HOLDER,
  NAVI_SWITCHBOARD,
  NAVI_USDC_ASSET_ID,
  NAVI_USDC_FEED,
  NAVI_USDC_POOL,
  NAVI_USDC_PYTH_OBJECT,
  NAVI_USER_INFO,
  readNaviHoldings,
} from '../chains/sui/navi-withdraw'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If the holder moves its funds these fail, so
 * swap it for another wallet whose only NAVI position is USDC.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_ONLY = '0xb26c1e93bed3707be8bb037aa36e9d2d4f640dbd4b470a214ab3e1b59983a40a'
const NEVER_USED = '0x0000000000000000000000000000000000000000000000000000000000001234'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''

describe.skipIf(SKIP)('NAVI withdrawals against mainnet', () => {
  it("still matches NAVI's published config, or the pins need a fresh look", async () => {
    const config = await getConfig({ env: 'prod' })
    expect(config.storage).toBe(NAVI_STORAGE)
    expect(config.incentiveV2).toBe(NAVI_INCENTIVE_V2)
    expect(config.incentiveV3).toBe(NAVI_INCENTIVE_V3)
    expect(config.priceOracle).toBe(NAVI_PRICE_ORACLE)
    expect(config.oracle.packageId).toBe(NAVI_ORACLE_PACKAGE)
    expect(config.oracle.oracleConfig).toBe(NAVI_ORACLE_CONFIG)
    expect(config.oracle.supraOracleHolder).toBe(NAVI_SUPRA_HOLDER)
    expect(config.oracle.switchboardAggregator).toBe(NAVI_SWITCHBOARD)
    expect(config.oracle.updateFunction).toBe('update_single_price_v3')
    const feed = config.oracle.feeds.find((f) => f.oracleId === NAVI_USDC_ASSET_ID)
    expect(feed?.feedId).toBe(NAVI_USDC_FEED)
    expect(feed?.pythPriceInfoObject).toBe(NAVI_USDC_PYTH_OBJECT)
  }, 30_000)

  it("still has the pinned USDC pool in NAVI's list", async () => {
    const pools = await getPools({ env: 'prod' })
    const pool = pools.find((p) => p.id === NAVI_USDC_ASSET_ID)
    expect(pool?.contract.pool).toBe(NAVI_USDC_POOL)
    expect(pool?.suiCoinType).toBe(USDC)
  }, 30_000)

  it('has the user table on the pinned storage object', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: NAVI_STORAGE,
      include: { json: true },
    })
    const json = object.json as { user_info: { id: string } }
    expect(json.user_info.id).toBe(NAVI_USER_INFO)
  }, 30_000)

  it('reads holdings from the chain, and finds none for an unused wallet', async () => {
    expect((await readNaviHoldings(USDC_ONLY))?.collaterals).toEqual([NAVI_USDC_ASSET_ID])
    expect(await readNaviHoldings(NEVER_USED)).toBeUndefined()
  }, 30_000)

  it('builds a withdrawal from pinned ids, passes its check and pays what was asked', async () => {
    const prepared = await naviVenue.prepare(
      { kind: 'withdraw', amount: '0.001', tokenIn: 'USDC' },
      USDC_ONLY
    )
    expect(() => naviVenue.assertSafe(prepared.signing, USDC_ONLY)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(prepared.signing.transaction, USDC, USDC_ONLY, 'Dry run')
    expect(Number(received)).toBe(1000)
  }, 60_000)

  it('says what the wallet holds when asked for more', async () => {
    await expect(
      naviVenue.prepare({ kind: 'withdraw', amount: '1000', tokenIn: 'USDC' }, USDC_ONLY)
    ).rejects.toThrow(/You have about .* USDC in NAVI/)
  }, 60_000)
})
