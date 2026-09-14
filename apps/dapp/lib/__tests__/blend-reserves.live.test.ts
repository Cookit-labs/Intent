import { describe, expect, it } from 'vitest'

import { readPoolRates, readReserve, readReserveList } from '../lend/reserves'

/**
 * The reserve reader against the real testnet pool.
 *
 * Skipped when `SKIP_LIVE` is set, like every other network test here. Worth
 * having despite the unit tests above: those pin the maths to figures captured
 * once, and only this catches the pool moving underneath them — a redeploy, a
 * reconfigured curve, or a reserve list that no longer starts with XLM.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

/** Blend's XLM reserve, read from `get_reserve_list` rather than derived. */
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

describe.skipIf(SKIP)('the live Blend pool', () => {
  it('lists the assets it accepts', async () => {
    const list = await readReserveList()
    expect(list.length).toBeGreaterThan(0)
    expect(list).toContain(XLM_SAC)
  }, 30_000)

  it('does not accept an asset merely because it shares a ticker', async () => {
    // Blend's USDC is a third distinct issuer from Circle's and Soroswap's, so
    // an id derived from the ticker names an asset this pool has never heard
    // of. This is the check that keeps a lend target honest.
    const list = await readReserveList()
    const circleUsdcSac = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
    expect(list).not.toContain(circleUsdcSac)
  }, 30_000)

  it('reads the XLM reserve and derives a rate', async () => {
    const reserve = await readReserve(XLM_SAC)

    expect(reserve.asset).toBe(XLM_SAC)
    expect(reserve.config.enabled).toBe(true)
    expect(reserve.config.decimals).toBe(7)

    // Bounds rather than exact figures: interest accrues every ledger, so a
    // pinned number here would fail on its own within minutes.
    expect(reserve.utilisation).toBeGreaterThan(0)
    expect(reserve.utilisation).toBeLessThanOrEqual(1)
    expect(reserve.supplyApy).toBeGreaterThan(0)
    expect(reserve.borrowApy).toBeGreaterThan(0)
  }, 30_000)

  it('never reports suppliers earning more than borrowers pay', async () => {
    // The invariant that survives any pool state. If this breaks, the scales
    // are wrong again rather than the pool being unusual.
    const reserve = await readReserve(XLM_SAC)
    expect(reserve.supplyApr).toBeLessThan(reserve.borrowApy)
  }, 30_000)

  it('reads the backstop take rate from the pool rather than assuming it', async () => {
    const rates = await readPoolRates()
    expect(rates.backstopTakeRate).toBeGreaterThan(BigInt(0))
    expect(rates.backstopTakeRate).toBeLessThan(BigInt(10_000_000))
  }, 30_000)

  it('refuses an asset the pool has no reserve for', async () => {
    const stranger = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
    await expect(readReserve(stranger)).rejects.toThrow()
  }, 30_000)
})
