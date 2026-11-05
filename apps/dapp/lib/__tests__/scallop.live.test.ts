import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { dryRunChange } from '../chains/sui/lending-calls'
import {
  SCALLOP_MARKET,
  SCALLOP_ORIGINAL_PACKAGE,
  SCALLOP_PACKAGE,
  SCALLOP_RECEIPT_TYPE,
  SCALLOP_UPGRADE_CAP,
  SCALLOP_VERSION,
  scallopVenue,
} from '../chains/sui/scallop'
import { SUI_TOKENS } from '../chains/sui/tokens'

/**
 * Real transactions built and dry-run against mainnet, for public addresses whose keys
 * nobody here has. Nothing signs or sends. If a holder moves its funds these fail on
 * balance, so swap it for another that holds USDC receipts.
 */
const SKIP = process.env['SKIP_LIVE'] === '1'
const USDC_HOLDER = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const RECEIPT_HOLDER = '0xbe3fd04e98d2a2603122a3d2f7459e5ecef01768f1dc40cded8203995305203f'
const USDC = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id ?? ''

describe.skipIf(SKIP)('Scallop against mainnet', () => {
  it('still has the pinned package as its latest, or the allowlist needs a fresh look', async () => {
    const { object } = await suiClient().core.getObject({
      objectId: SCALLOP_UPGRADE_CAP,
      include: { json: true },
    })
    expect((object.json as { package?: string }).package).toBe(SCALLOP_PACKAGE)
  }, 30_000)

  it('still has the pinned market and version objects', async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: [SCALLOP_MARKET, SCALLOP_VERSION],
    })
    const [market, version] = objects as unknown as [{ type?: string }, { type?: string }]
    expect(market.type).toBe(`${SCALLOP_ORIGINAL_PACKAGE}::market::Market`)
    expect(version.type).toBe(`${SCALLOP_ORIGINAL_PACKAGE}::version::Version`)
  }, 30_000)

  it('builds a supply with a rate, passes its check and dry-runs clean', async () => {
    const prepared = await scallopVenue.prepare(
      { kind: 'supply', amount: '1', tokenIn: 'USDC' },
      USDC_HOLDER
    )
    expect(prepared.apy?.basePercent).toBeGreaterThan(0)
    expect(Number(prepared.receive?.amount)).toBeGreaterThan(0)
    expect(prepared.notes.join(' ')).toMatch(/\$142K/)
    expect(() => scallopVenue.assertSafe(prepared.signing, USDC_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const minted = await dryRunChange(
      prepared.signing.transaction,
      SCALLOP_RECEIPT_TYPE,
      USDC_HOLDER,
      'Dry run'
    )
    expect(Number(minted)).toBeGreaterThan(0)
  }, 60_000)

  it('builds a withdrawal and pays what was asked', async () => {
    const prepared = await scallopVenue.prepare(
      { kind: 'withdraw', amount: '1', tokenIn: 'USDC' },
      RECEIPT_HOLDER
    )
    expect(() => scallopVenue.assertSafe(prepared.signing, RECEIPT_HOLDER)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const received = await dryRunChange(
      prepared.signing.transaction,
      USDC,
      RECEIPT_HOLDER,
      'Dry run'
    )
    expect(Number(received)).toBeGreaterThanOrEqual(999_900)
  }, 60_000)

  it('refuses a wallet with no receipts', async () => {
    await expect(
      scallopVenue.prepare({ kind: 'withdraw', amount: '1', tokenIn: 'USDC' }, USDC_HOLDER)
    ).rejects.toThrow(/no Scallop USDC receipts/)
  }, 30_000)
})
