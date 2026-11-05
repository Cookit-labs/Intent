import { Transaction } from '@mysten/sui/transactions'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { dryRunChange } from '../chains/sui/lending-calls'
import {
  SUILEND_MARKET,
  SUILEND_ORIGINAL_PACKAGE,
  SUILEND_PACKAGE,
  SUILEND_UPGRADE_CAP,
  SUILEND_USDC_RESERVE,
  suilendVenue,
} from '../chains/sui/suilend'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If a holder moves its funds these fail on
 * balance, so swap it for another with a loan-free USDC position.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const SUPPLIER = '0xd22978af0d4d404067dc611d1f63af9883b5a1786e24813290ccb2d8407b1b66'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''

describe.skipIf(SKIP)('Suilend against mainnet', () => {
  it('still has the pinned package as its latest, or the allowlist needs a fresh look', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_UPGRADE_CAP,
      include: { json: true },
    })
    expect((object.json as { package?: string }).package).toBe(SUILEND_PACKAGE)
  }, 30_000)

  it('still has USDC at the pinned reserve of the pinned market, at version 7', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SUILEND_MARKET,
      include: { json: true },
    })
    expect(object.type).toContain(`${SUILEND_ORIGINAL_PACKAGE}::lending_market::LendingMarket<`)
    const json = object.json as { version: string; reserves: { coin_type: string }[] }
    expect(json.version).toBe('7')
    expect(USDC).toContain(json.reserves[SUILEND_USDC_RESERVE]?.coin_type)
  }, 30_000)

  it('builds a first supply with a rate, passes its check and dry-runs clean', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      USDC_HOLDER
    )
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(prepared.apy?.rewardPercent).toBeUndefined()
    expect(() => suilendVenue.assertSafe(prepared.signing, USDC_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    expect(Transaction.from(prepared.signing.transaction).getData().sender).toBe(USDC_HOLDER)
    expect(await dryRunChange(prepared.signing.transaction, USDC, USDC_HOLDER, 'Dry run')).toBe(
      BigInt(-1_000_000)
    )
  }, 60_000)

  it('builds a withdrawal with no price update and no server, and pays what was asked', async () => {
    const prepared = await suilendVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'USDC' },
      SUPPLIER
    )
    expect(() => suilendVenue.assertSafe(prepared.signing, SUPPLIER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(prepared.signing.transaction, USDC, SUPPLIER, 'Dry run')
    expect(Number(received)).toBeGreaterThanOrEqual(999_900)
  }, 60_000)

  it('refuses a wallet with no position', async () => {
    await expect(
      suilendVenue.prepare({ kind: 'withdraw', amount: '1', tokenIn: 'USDC' }, USDC_HOLDER)
    ).rejects.toThrow(/no USDC in Suilend/)
  }, 30_000)
})
