import { fromBase64 } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import {
  HAEDAL_PACKAGE,
  HAEDAL_STAKING,
  haedalVenue,
  HASUI_TYPE,
  readObjectJson,
  readU64,
} from '../chains/sui/haedal'

/**
 * Pinned ids, and real unsigned transactions against mainnet, read-only. Nothing here signs or
 * sends: each transaction is only built and dry-run, for public addresses whose keys nobody here
 * has. When an address empties these fail on balance, so swap it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SUI_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const HASUI_HOLDER = '0x4d91d2c4fd130a651e42a2c3347217653eb84e87c4123ac4952a65292afca1fb'
/** Haedal's UpgradeCap. Its `package` field is the latest package. */
const UPGRADE_CAP = '0xc1c6690f21937f90e6b42f7c916d8e8c942926e3fb9e5c3c5584ae1e91502f25'

async function simulateOk(transaction: string): Promise<boolean> {
  const result = await suiClient().core.simulateTransaction({
    transaction: fromBase64(transaction),
    include: { effects: true },
  })
  return result.Transaction?.effects?.status.success === true
}

describe.skipIf(SKIP)('Haedal against mainnet', () => {
  it('builds a stake that passes its check and dry-runs clean', async () => {
    const prepared = await haedalVenue.prepare(
      { kind: 'stake', amount: '1', tokenIn: 'SUI' },
      SUI_HOLDER
    )
    expect(prepared.receive?.symbol).toBe('haSUI')
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0.5)
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => haedalVenue.assertSafe(prepared.signing, SUI_HOLDER)).not.toThrow()
    expect(await simulateOk(prepared.signing.transaction)).toBe(true)
  }, 60_000)

  it('builds an instant unstake that pays the value it read, less only the fee it read', async () => {
    const prepared = await haedalVenue.prepare(
      { kind: 'unstake', amount: '1.5', tokenIn: 'haSUI' },
      HASUI_HOLDER
    )
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(() => haedalVenue.assertSafe(prepared.signing, HASUI_HOLDER)).not.toThrow()
    expect(await simulateOk(prepared.signing.transaction)).toBe(true)

    const value = await readU64(
      HASUI_HOLDER,
      `${HAEDAL_PACKAGE}::staking::get_sui_by_stsui`,
      (tx) => [tx.object(HAEDAL_STAKING), tx.pure.u64(BigInt(1_500_000_000))]
    )
    const staking = await readObjectJson(HAEDAL_STAKING)
    const config = staking?.['config'] as { service_fee: string }
    const expected = (Number(value) * (1 - Number(config.service_fee) / 10_000_000)) / 1e9
    expect(prepared.receive?.symbol).toBe('SUI')
    expect(Math.abs(Number(prepared.receive?.amount) - expected)).toBeLessThan(0.00001)
  }, 60_000)

  it("still matches Haedal's upgrade cap and objects, or the ids need a fresh look", async () => {
    const cap = await readObjectJson(UPGRADE_CAP)
    expect(cap?.['package']).toBe(HAEDAL_PACKAGE)
    const staking = await readObjectJson(HAEDAL_STAKING)
    expect(staking?.['id']).toBe(HAEDAL_STAKING)
    const { coinMetadata } = await suiClient().core.getCoinMetadata({ coinType: HASUI_TYPE })
    expect(coinMetadata?.symbol).toBe('haSUI')
    expect(coinMetadata?.decimals).toBe(9)
  }, 30_000)
})
