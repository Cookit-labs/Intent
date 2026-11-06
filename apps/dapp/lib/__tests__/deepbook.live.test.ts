import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'

import { suiClient } from '../chains/sui/client'
import { DEEP_TYPE, DEEPBOOK_PACKAGE, DEEPBOOK_POOLS, deepbookVenue } from '../chains/sui/deepbook'
import { tokenType } from '../chains/sui/direct-swap'

/**
 * Read-only against mainnet: everything is built and dry-run, for a public address holding USDC
 * and SUI whose key nobody here has. When that address empties the swaps fail on balance, so swap
 * it for another funded one.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ACCOUNT = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const REGISTRY = '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d'
const UPGRADE_CAP = '0xdadf253cea3b91010e64651b03da6d56166a4f44b43bdd4e185c277658634483'
const USDC = tokenType('USDC')

describe.skipIf(SKIP)('DeepBook against mainnet', () => {
  it('still matches its upgrade cap, or the package needs a fresh look', async () => {
    const { objects } = await suiClient().core.getObjects({
      objectIds: [UPGRADE_CAP],
      include: { json: true },
    })
    const [cap] = objects as unknown as [{ json?: { package?: string } }]
    expect(cap.json?.package).toBe(DEEPBOOK_PACKAGE)
  }, 30_000)

  it.each(DEEPBOOK_POOLS.map((p) => [`${p.base}/${p.quote}`, p] as const))(
    '%s is still the pool the registry names, of those coins',
    async (_name, pool) => {
      const typeArguments = [tokenType(pool.base), tokenType(pool.quote)]
      const { objects } = await suiClient().core.getObjects({ objectIds: [pool.id] })
      const [object] = objects as unknown as [
        { type?: string; owner?: { Shared?: { initialSharedVersion: string } } },
      ]
      expect(object.type).toContain(`pool::Pool<${typeArguments[0]},${typeArguments[1]}>`)
      expect(object.owner?.Shared?.initialSharedVersion).toBe(String(pool.initialSharedVersion))

      const tx = new Transaction()
      tx.setSender(ACCOUNT)
      tx.moveCall({
        target: `${DEEPBOOK_PACKAGE}::pool::get_pool_id_by_asset`,
        typeArguments,
        arguments: [tx.object(REGISTRY)],
      })
      const result = await suiClient().core.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
      })
      const id = result.commandResults?.[0]?.returnValues[0]?.bcs
      expect(id && bcs.Address.parse(id)).toBe(pool.id)
    },
    30_000
  )

  it('still names the DEEP coin this file pins in its swap signature', async () => {
    const shape = await suiClient().core.getMoveFunction({
      packageId: DEEPBOOK_PACKAGE,
      moduleName: 'pool',
      name: 'swap_exact_base_for_quote',
    })
    expect(JSON.stringify(shape)).toContain(normalizeStructTag(DEEP_TYPE))
  }, 30_000)

  it('quotes USDC for SUI, builds it, passes the check, and the dry run pays near the quote', async () => {
    const request = { kind: 'swap', amount: '20', tokenIn: 'SUI', tokenOut: 'USDC' } as const
    const quoted = await deepbookVenue.quote?.(request, ACCOUNT)
    const prepared = await deepbookVenue.prepare(request, ACCOUNT)
    expect(() => deepbookVenue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
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
    const prepared = await deepbookVenue.prepare(
      { kind: 'swap', amount: '20', tokenIn: 'USDC', tokenOut: 'SUI' },
      ACCOUNT
    )
    expect(() => deepbookVenue.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    if (prepared.signing.family !== 'sui') throw new Error('wrong family')
    const result = await suiClient().core.simulateTransaction({
      transaction: fromBase64(prepared.signing.transaction),
      include: { effects: true },
    })
    expect(result.Transaction?.effects?.status.success).toBe(true)
  }, 60_000)
})
