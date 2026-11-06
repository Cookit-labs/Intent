import { normalizeStructTag } from '@mysten/sui/utils'
import { getConfig, getPools } from '@naviprotocol/lending'
import { describe, expect, it } from 'vitest'

import { dryRunChange } from '../chains/sui/lending-calls'
import { naviVenue } from '../chains/sui/navi'
import {
  NAVI_ASSETS,
  NAVI_FEEDS,
  NAVI_INCENTIVE_V2,
  NAVI_INCENTIVE_V3,
  NAVI_ORACLE_CONFIG,
  NAVI_ORACLE_PACKAGE,
  NAVI_PRICE_ORACLE,
  NAVI_STORAGE,
  NAVI_SUPRA_HOLDER,
  NAVI_SWITCHBOARD,
  NAVI_UI_GETTER,
  NAVI_USDC_ASSET_ID,
  NAVI_USDC_FEED,
  NAVI_USDC_POOL,
  NAVI_USDC_PYTH_OBJECT,
  naviChainReader,
  readNaviPositions,
} from '../chains/sui/navi-withdraw'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If a holder moves its funds these fail, so
 * swap it for another wallet with the position its comment describes.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_ONLY = '0xb26c1e93bed3707be8bb037aa36e9d2d4f640dbd4b470a214ab3e1b59983a40a'
/** Owes USDC and USDsui against several assets. */
const BORROWER = '0x4e677759eda54f1caee2b93d52c2ebb74f60d66e843b91429ea24fb4ba29ae70'
/** Owes a little USDC against USDC, and holds enough USDC to clear it. */
const SMALL_LOAN = '0xf5495ebdb1936083adf3316f6b9500d578f106e95008ea7337c7bfacfa10d219'
/** Owes a lot of USDC against SUI and haSUI, and holds no USDC. */
const SUI_COLLATERAL = '0x82f39aef0914182f43682d3af19a4f5f0589e20a8a3a88a482934751b51a7f10'
/** Owes USDC against plenty of SUI, with room to borrow more. */
const ROOMY = '0xa728219749ee5fdf2ee0cbd13bab1b6ce9f9beb81662a405c97c9f682a83960c'
const NEVER_USED = '0x0000000000000000000000000000000000000000000000000000000000001234'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''

describe.skipIf(SKIP)('NAVI against mainnet', () => {
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
    expect(config.uiGetter).toBe(NAVI_UI_GETTER)
    const feed = config.oracle.feeds.find((f) => f.oracleId === NAVI_USDC_ASSET_ID)
    expect(feed?.feedId).toBe(NAVI_USDC_FEED)
    expect(feed?.pythPriceInfoObject).toBe(NAVI_USDC_PYTH_OBJECT)
    expect(NAVI_FEEDS).toEqual(
      config.oracle.feeds.map((f) => [f.oracleId, f.feedId, f.pythPriceInfoObject])
    )
  }, 30_000)

  it("still has the pinned pools in NAVI's list", async () => {
    const pools = await getPools({ env: 'prod' })
    const pool = pools.find((p) => p.id === NAVI_USDC_ASSET_ID)
    expect(pool?.contract.pool).toBe(NAVI_USDC_POOL)
    expect(pool?.suiCoinType).toBe(USDC)
    for (const asset of NAVI_ASSETS) {
      const listed = pools.find((p) => p.id === asset.assetId)
      expect(listed?.contract.pool).toBe(asset.pool)
      const type = SUI_TOKENS.find((t) => t.symbol === asset.symbol)?.id
      expect(normalizeStructTag(listed?.suiCoinType ?? '')).toBe(normalizeStructTag(type ?? ''))
    }
  }, 30_000)

  it('reads positions from the chain, with interest, and none for an unused wallet', async () => {
    const usdcOnly = await readNaviPositions(USDC_ONLY)
    expect(usdcOnly.map((p) => [p.slot, p.symbol])).toEqual([['supplied', 'USDC']])
    expect(Number(usdcOnly[0]?.amount)).toBeGreaterThan(0)

    const held = await readNaviPositions(BORROWER)
    expect(held.find((p) => p.slot === 'borrowed' && p.symbol === 'USDC')).toBeDefined()
    expect(held.find((p) => p.slot === 'borrowed' && p.symbol === 'USDsui')).toBeDefined()

    expect(await readNaviPositions(NEVER_USED)).toEqual([])
  }, 30_000)

  it('reads a position in dollars from the contract, with its assets priced', async () => {
    const held = await naviChainReader.account(BORROWER)
    const standing = await naviChainReader.standing(BORROWER, [
      ...new Set([...held.supplied.keys(), ...held.owed.keys()]),
    ])
    expect(standing.owedUsd).toBeGreaterThan(0)
    expect(standing.limitUsd).toBeGreaterThan(standing.owedUsd)
    expect(standing.liquidationUsd).toBeGreaterThan(standing.limitUsd)
  }, 30_000)

  it('builds a borrow with no key and no price service, and pays what was asked', async () => {
    const prepared = await naviVenue.prepare(
      { kind: 'borrow', amount: '0.5', tokenIn: 'USDC' },
      ROOMY
    )
    expect(() => naviVenue.assertSafe(prepared.signing, ROOMY)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(prepared.signing.transaction, USDC, ROOMY, 'Dry run')).toBe(
      BigInt(500_000)
    )
    expect(prepared.notes.join(' ')).toMatch(/can be liquidated/)
    expect(prepared.notes.join(' ')).toMatch(/fee on this borrow/)
  }, 60_000)

  it('borrows SUI through the call that can unstake it, net of the network fee', async () => {
    const prepared = await naviVenue.prepare(
      { kind: 'borrow', amount: '0.1', tokenIn: 'SUI' },
      ROOMY
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(
      await dryRunChange(prepared.signing.transaction, '0x2::sui::SUI', ROOMY, 'Dry run')
    ).toBe(BigInt(100_000_000))
  }, 60_000)

  it('withdraws collateral a loan can spare, and says what is left', async () => {
    const prepared = await naviVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'SUI' },
      ROOMY
    )
    expect(() => naviVenue.assertSafe(prepared.signing, ROOMY)).not.toThrow()
    expect(prepared.notes.join(' ')).toMatch(/backs your loan/)
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(
      await dryRunChange(prepared.signing.transaction, '0x2::sui::SUI', ROOMY, 'Dry run')
    ).toBe(BigInt(1_000_000_000))
  }, 60_000)

  it('refuses a borrow past what the collateral can back', async () => {
    await expect(
      naviVenue.prepare({ kind: 'borrow', amount: '100000000', tokenIn: 'USDC' }, SUI_COLLATERAL)
    ).rejects.toThrow(/can back about|can't back any more/)
  }, 60_000)

  it('refuses a borrow with nothing to borrow against', async () => {
    await expect(
      naviVenue.prepare({ kind: 'borrow', amount: '1', tokenIn: 'USDC' }, NEVER_USED)
    ).rejects.toThrow(/no collateral on NAVI/)
  }, 60_000)

  it('repays part of a loan, taking exactly what was asked', async () => {
    const prepared = await naviVenue.prepare(
      { kind: 'repay', amount: '0.01', tokenIn: 'USDC' },
      SMALL_LOAN
    )
    expect(() => naviVenue.assertSafe(prepared.signing, SMALL_LOAN)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(await dryRunChange(prepared.signing.transaction, USDC, SMALL_LOAN, 'Dry run')).toBe(
      BigInt(-10_000)
    )
  }, 60_000)

  it('clears a whole loan, interest included, and keeps the extra it offered', async () => {
    const owed = (await readNaviPositions(SMALL_LOAN)).find(
      (p) => p.slot === 'borrowed' && p.symbol === 'USDC'
    )
    if (owed === undefined) throw new Error('this wallet no longer owes USDC')
    const prepared = await naviVenue.prepare(
      { kind: 'repay', amount: owed.amount, tokenIn: 'USDC', wholePosition: true },
      SMALL_LOAN
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const paid = await dryRunChange(prepared.signing.transaction, USDC, SMALL_LOAN, 'Dry run')
    const owedUnits = Math.round(Number(owed.amount) * 1e6)
    // The figure read is within a few units of what the contract charged, and the extra came back.
    expect(Math.abs(Number(paid) + owedUnits)).toBeLessThanOrEqual(3)
  }, 60_000)

  it('refuses a whole repay the wallet cannot cover', async () => {
    const owed = (await readNaviPositions(SUI_COLLATERAL)).find(
      (p) => p.slot === 'borrowed' && p.symbol === 'USDC'
    )
    if (owed === undefined) throw new Error('this wallet no longer owes USDC')
    await expect(
      naviVenue.prepare(
        { kind: 'repay', amount: owed.amount, tokenIn: 'USDC', wholePosition: true },
        SUI_COLLATERAL
      )
    ).rejects.toThrow(/which is less than the .* you owe/)
  }, 60_000)

  it('refuses taking out what a loan depends on, and says so', async () => {
    const held = await readNaviPositions(SUI_COLLATERAL)
    const sui = held.find((p) => p.slot === 'supplied' && p.symbol === 'SUI')
    if (sui === undefined) throw new Error('this wallet no longer supplies SUI')
    await expect(
      naviVenue.prepare(
        { kind: 'withdraw', amount: sui.amount, tokenIn: 'SUI', wholePosition: true },
        SUI_COLLATERAL
      )
    ).rejects.toThrow(/Your loan on NAVI depends on this SUI/)
  }, 60_000)

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

  it('empties a position on a whole withdraw, past the figure read', async () => {
    const [held] = await readNaviPositions(USDC_ONLY)
    if (held === undefined) throw new Error('this wallet no longer supplies USDC')
    const prepared = await naviVenue.prepare(
      { kind: 'withdraw', amount: held.amount, tokenIn: 'USDC', wholePosition: true },
      USDC_ONLY
    )
    expect(() => naviVenue.assertSafe(prepared.signing, USDC_ONLY)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(prepared.signing.transaction, USDC, USDC_ONLY, 'Dry run')
    expect(Number(received)).toBeGreaterThanOrEqual(Math.floor(Number(held.amount) * 1e6))
  }, 60_000)

  it('says what the wallet holds when asked for more', async () => {
    await expect(
      naviVenue.prepare({ kind: 'withdraw', amount: '1000', tokenIn: 'USDC' }, USDC_ONLY)
    ).rejects.toThrow(/You have about .* USDC in NAVI/)
  }, 60_000)
})
