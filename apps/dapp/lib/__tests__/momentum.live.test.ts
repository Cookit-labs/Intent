import { fromBase64, normalizeStructTag } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { tokenType } from '../chains/sui/direct-swap'
import {
  MOMENTUM_PACKAGE,
  MOMENTUM_POOLS,
  MOMENTUM_VERSION,
  momentumVenue,
} from '../chains/sui/momentum'

/**
 * Read-only against mainnet: everything is built and dry-run, for a public address holding USDC
 * and SUI whose key nobody here has. When that address empties the swaps fail on balance, so swap
 * it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ACCOUNT = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const UPGRADE_CAP = '0x59d16188948e7b89791271c7af78cb877092b8858db44c9166b8af9dee55dcb4'
const ORIGINAL_PACKAGE = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860'
const USDC = tokenType('USDC')

describe.skipIf(SKIP)('Momentum against mainnet', () => {
  it('still matches its upgrade cap, or the package needs a fresh look', async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: [UPGRADE_CAP],
      include: { json: true },
    })
    const [cap] = objects as unknown as [{ json?: { package?: string } }]
    expect(cap.json?.package).toBe(MOMENTUM_PACKAGE)
  }, 30_000)

  it('still has the version object it pins', async () => {
    const { objects } = await suiClient().core.getObjects({ objectIds: [MOMENTUM_VERSION] })
    const [version] = objects as unknown as [{ type?: string }]
    expect(version.type).toBe(`${ORIGINAL_PACKAGE}::version::Version`)
  }, 30_000)

  it.each(MOMENTUM_POOLS.map((p) => [`${p.x}/${p.y}`, p] as const))(
    '%s is still a pool of those coins',
    async (_name, pool) => {
      const { objects } = await suiClient().core.getObjects({ objectIds: [pool.id] })
      const [object] = objects as unknown as [
        { type?: string; owner?: { Shared?: { initialSharedVersion: string } } },
      ]
      expect(object.type).toBe(
        `${ORIGINAL_PACKAGE}::pool::Pool<${tokenType(pool.x)},${tokenType(pool.y)}>`
      )
      expect(object.owner?.Shared?.initialSharedVersion).toBe(String(pool.initialSharedVersion))
    },
    30_000
  )

  it('quotes USDC for SUI, builds it, passes the check, and the dry run pays near the quote', async () => {
    const request = { kind: 'swap', amount: '5', tokenIn: 'SUI', tokenOut: 'USDC' } as const
    const quoted = await momentumVenue.quote?.(request, ACCOUNT)
    const prepared = await momentumVenue.prepare(request, ACCOUNT)
    expect(() => momentumVenue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')

    const result = await suiClient().core.simulateTransaction({
      transaction: fromBase64(prepared.signing.transaction),
      include: { balanceChanges: true, effects: true },
    })
    expect(result.Transaction?.effects?.status.success).toBe(true)
    const paid = result.Transaction?.balanceChanges?.find(
      (c) => normalizeStructTag(c.coinType) === USDC && c.address === ACCOUNT
    )
    const got = Number(paid?.amount) / 1e6
    expect(got).toBeGreaterThan(Number(quoted?.receive?.amount) * 0.995)
    expect(got).toBeLessThan(Number(quoted?.receive?.amount) * 1.005)
  }, 60_000)

  it('builds SUI for USDC the other way, and the dry run passes', async () => {
    const prepared = await momentumVenue.prepare(
      { kind: 'swap', amount: '5', tokenIn: 'USDC', tokenOut: 'SUI' },
      ACCOUNT
    )
    expect(() => momentumVenue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const result = await suiClient().core.simulateTransaction({
      transaction: fromBase64(prepared.signing.transaction),
      include: { effects: true },
    })
    expect(result.Transaction?.effects?.status.success).toBe(true)
  }, 60_000)
})
