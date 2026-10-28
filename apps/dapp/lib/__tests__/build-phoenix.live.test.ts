import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A Phoenix swap, simulated against the live pool, on mainnet.
 *
 * Phoenix has no testnet instance (see `contract-registry.ts`'s
 * `phoenixFactory`), so unlike the Aquarius equivalent this runs against
 * mainnet — read-only: nothing here signs or submits, and `prepareSorobanSwap`
 * only simulates. The network is stubbed for the module graph this test
 * needs, the same way `contract-registry-networks.test.ts` does, rather than
 * assuming the ambient test environment happens to be mainnet.
 *
 * This is the check that catches an `i128` encoded as `u128`, an `Option`
 * encoded wrong, or a pool address the factory no longer recognises — each
 * of which fails in simulation with an error that names none of those
 * things, and none of which a fixture written from this module's own
 * assumptions would ever see.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'

type Loaded = {
  resolveAsset: typeof import('../swap/assets').resolveAsset
  buildPhoenixSwap: typeof import('../swap/build-phoenix').buildPhoenixSwap
  prepareSorobanSwap: typeof import('../swap/build-soroban').prepareSorobanSwap
  // Built, not just imported, while the mainnet stub is still active: the
  // quoter's factory id is resolved once, at construction, by reading
  // activeNetwork() through phoenixFactory() — resolving it later, after
  // vi.unstubAllEnvs() has already run, would silently build it against
  // testnet (where Phoenix has no id) and every quote would come back
  // "unsupported_pair" with no hint that the network, not Phoenix, was wrong.
  quoter: import('../swap/quote').QuoteSource
}

let mod: Loaded

beforeAll(async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  const [{ resolveAsset }, { buildPhoenixSwap }, { prepareSorobanSwap }, { createPhoenixQuoter }] =
    await Promise.all([
      import('../swap/assets'),
      import('../swap/build-phoenix'),
      import('../swap/build-soroban'),
      import('../swap/sources/phoenix-quoter'),
    ])
  const quoter = createPhoenixQuoter()
  mod = { resolveAsset, buildPhoenixSwap, prepareSorobanSwap, quoter }
  // Deliberately not unstubbed here: buildPhoenixSwap and assertVenueOn also
  // read activeNetwork() at call time, inside the tests below, not only at
  // construction. The stub stays live for the whole suite and is removed
  // only once nothing here will call activeNetwork() again.
}, 30_000)

afterAll(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe.skipIf(SKIP)('a Phoenix swap the pool accepts', () => {
  it('quotes, builds against the quoted pool, and simulates clean', async () => {
    const XLM = mod.resolveAsset('XLM')
    const USDC = mod.resolveAsset('USDC')
    if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

    const quote = await mod.quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '10000000', // 1 XLM
    })
    if (!quote.ok) throw new Error(`no quote: ${quote.failure.reason}`)
    if (quote.quote.poolAddress === undefined) throw new Error('quote carried no pool address')

    // A floor well under the quote, so the simulation tests the call shape
    // and not the price having moved between the two calls.
    const minReceive = (BigInt(quote.quote.destAmount) / BigInt(2)).toString()

    const built = await mod.buildPhoenixSwap({
      account: ME,
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
      minReceive,
      poolAddress: quote.quote.poolAddress,
    })

    const prepared = await mod.prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.reason)
  }, 60_000)

  it('is refused by the pool when the floor is above what it would pay', async () => {
    const XLM = mod.resolveAsset('XLM')
    const USDC = mod.resolveAsset('USDC')
    if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

    const quote = await mod.quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
    })
    if (!quote.ok || quote.quote.poolAddress === undefined) throw new Error('no quote')

    const tooHigh = (BigInt(quote.quote.destAmount) * BigInt(10)).toString()
    const built = await mod.buildPhoenixSwap({
      account: ME,
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
      minReceive: tooHigh,
      poolAddress: quote.quote.poolAddress,
    })

    const prepared = await mod.prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(false)
  }, 60_000)
})
