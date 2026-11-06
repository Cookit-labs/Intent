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
 *
 * The account is looked up rather than pinned. A simulation really moves the
 * tokens, so it needs an account that can spend them, and any one wallet's
 * balance is not ours to rely on: this suite once pinned a wallet that fell to
 * 1.68 XLM, and every run then failed on the wallet with Phoenix working fine.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const HORIZON = 'https://horizon.stellar.org'
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

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
let funded: string

interface HorizonAccount {
  id: string
  balances: { asset_type: string; asset_code?: string; balance: string; limit?: string }[]
}

/** An account with a USDC trustline and XLM to spare, so a swap tests Phoenix and not the wallet. */
async function fundedAccount(): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts?asset=USDC:${USDC_ISSUER}&limit=200&order=desc`)
  if (!res.ok) throw new Error(`Horizon ${res.status}`)
  const body = (await res.json()) as { _embedded: { records: HorizonAccount[] } }

  const account = body._embedded.records.find((record) => {
    const xlm = record.balances.find((b) => b.asset_type === 'native')
    const usdc = record.balances.find((b) => b.asset_code === 'USDC')
    return (
      xlm !== undefined &&
      Number(xlm.balance) > 100 &&
      usdc !== undefined &&
      Number(usdc.limit) - Number(usdc.balance) > 100
    )
  })
  if (account === undefined) throw new Error('no funded account found on Horizon')
  return account.id
}

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
  if (!SKIP) funded = await fundedAccount()
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
      account: funded,
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
      minReceive,
      poolAddress: quote.quote.poolAddress,
    })

    const prepared = await mod.prepareSorobanSwap(built.xdr)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(prepared.ok).toBe(true)
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
      account: funded,
      from: XLM,
      to: USDC,
      sendAmount: '10000000',
      minReceive: tooHigh,
      poolAddress: quote.quote.poolAddress,
    })

    const prepared = await mod.prepareSorobanSwap(built.xdr)
    expect(prepared.ok).toBe(false)
    // Refused for the floor. A wallet that cannot pay fails too, and that would
    // pass here while proving nothing about the floor.
    if (!prepared.ok) expect(prepared.reason).not.toMatch(/resulting balance/)
  }, 60_000)
})
