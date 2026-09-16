import { describe, expect, it } from 'vitest'

import { fetchPools } from '../swap/liquidity-pools'
import { poolIdFor } from '../swap/build-pool'
import { registerTestnetAsset } from '../swap/testnet-assets'

/**
 * Pool addressing, checked against pools that actually exist.
 *
 * A pool id is derived locally from two assets and a fee, and everything else
 * depends on getting it right: a wrong id addresses a pool that does not
 * exist, and the deposit fails with nothing to explain why. Deriving it in a
 * test and comparing to Horizon is the only way to know the derivation agrees
 * with the network rather than merely with itself.
 *
 * This already caught one bug. `getLiquidityPoolId` returns a `Uint8Array`
 * rather than a Buffer, so `.toString('hex')` produced a comma-separated list
 * of byte values — the same encoding mistake that broke a signature earlier in
 * this project, in a completely different place.
 */

const live = process.env['SKIP_LIVE'] === '1' ? describe.skip : describe

live('a derived pool id matches the network', () => {
  it('reproduces the id of a real funded pool', async () => {
    const pools = await fetchPools({ limit: 200 })
    expect(pools.length, 'testnet has no funded pools to check against').toBeGreaterThan(0)

    // Any pool whose assets are both issued: a native side needs no
    // registration and would test less of the path.
    const target = pools.find((p) => p.assets.every((a) => a.issuer !== undefined))
    if (target === undefined) throw new Error('no fully-issued pool found')

    const [a, b] = target.assets
    if (a === undefined || b === undefined) throw new Error('pool has fewer than two assets')

    // Registered through the testnet tier, which is what these assets are:
    // of 142 issuers in funded pools, 139 publish no home domain at all.
    registerTestnetAsset({ code: a.code, issuer: a.issuer as string, discoveredIn: target.id })
    registerTestnetAsset({ code: b.code, issuer: b.issuer as string, discoveredIn: target.id })

    const derived = poolIdFor(
      { kind: 'classic', code: a.code, issuer: a.issuer as string },
      { kind: 'classic', code: b.code, issuer: b.issuer as string }
    )
    expect(derived).toBe(target.id)
  }, 30_000)

  it('derives the same id whichever order the assets are given', async () => {
    // Stellar identifies a pool by its assets in a canonical order. If this
    // ever diverges, half of all deposits address a pool that does not exist.
    const pools = await fetchPools({ limit: 200 })
    const target = pools.find((p) => p.assets.every((x) => x.issuer !== undefined))
    if (target === undefined) throw new Error('no fully-issued pool found')

    const [a, b] = target.assets
    const first = { kind: 'classic' as const, code: a?.code ?? '', issuer: a?.issuer as string }
    const second = { kind: 'classic' as const, code: b?.code ?? '', issuer: b?.issuer as string }

    expect(poolIdFor(first, second)).toBe(poolIdFor(second, first))
  }, 30_000)

  it('reads pools with both sides funded', async () => {
    const pools = await fetchPools({ limit: 200 })
    for (const p of pools) {
      expect(p.isEmpty, `${p.id} was returned but has an empty side`).toBe(false)
      expect(p.impliedPrice).toBeGreaterThan(0)
    }
  }, 30_000)
})
