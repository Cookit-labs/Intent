import { describe, expect, it } from 'vitest'

import { REFLECTOR_CEX_DEX, fetchReflectorPrices } from '../prices/reflector'
import { readOracleId, readOracleMeta } from '../lend/oracle'
import { fetchMarketPrices } from '../swap/prices'

/**
 * Reflector, live on testnet.
 *
 * Live rather than mocked for the reason every oracle test here is: the thing
 * most likely to be wrong is the enum arm, and a fixture written from this
 * module's own encoding cannot see that. Only the real contract answers
 * `null` to the wrong form.
 *
 * Also the only test that can catch a testnet reset. Three officially
 * documented oracle addresses were found dead that way during planning.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

describe.skipIf(SKIP)('the live Reflector CEX/DEX feed', () => {
  it('is reachable and reports fourteen decimals', async () => {
    const meta = await readOracleMeta(REFLECTOR_CEX_DEX)

    expect(meta.decimals).toBe(14)
    expect(meta.resolution).toBeGreaterThan(0)
  }, 60_000)

  it('is actively updating', async () => {
    // A feed more than two periods behind is treated as absent everywhere
    // else, so if this fails the app is silently on its fallback path.
    const meta = await readOracleMeta(REFLECTOR_CEX_DEX)
    const age = Math.floor(Date.now() / 1000) - meta.lastTimestamp

    expect(age).toBeLessThan(meta.resolution * 2)
  }, 60_000)

  it('prices XLM through the Other(symbol) arm', async () => {
    const got = await fetchReflectorPrices(['XLM'])

    expect(got['XLM']).toBeDefined()
    expect(got['XLM']?.source).toBe('reflector')
    expect(got['XLM']?.usd).toBeGreaterThan(0.01)
    expect(got['XLM']?.usd).toBeLessThan(10)
  }, 60_000)

  it('agrees with the mainnet order book to within half', async () => {
    // Both are real-world prices from different venues; they should be
    // close. The testnet book is the one that is not, and it is not consulted
    // here. A large disagreement means one of the two is broken, and this
    // says which by naming both.
    const [oracle, book] = await Promise.all([
      fetchReflectorPrices(['XLM']),
      fetchMarketPrices({ reflector: false }),
    ])
    const fromOracle = oracle['XLM']?.usd
    const fromBook = book['XLM']?.usd

    expect(fromOracle).toBeDefined()
    if (
      fromOracle === undefined ||
      fromBook === undefined ||
      book['XLM']?.source !== 'stellar-mainnet'
    ) {
      return
    }
    const ratio = fromOracle / fromBook
    expect(ratio).toBeGreaterThan(0.5)
    expect(ratio).toBeLessThan(2)
  }, 90_000)

  it('is what fetchMarketPrices now leads with', async () => {
    const prices = await fetchMarketPrices()
    expect(prices['XLM']?.source).toBe('reflector')
  }, 60_000)

  it('does not list a ticker it has no feed for', async () => {
    const got = await fetchReflectorPrices(['CETES'])
    expect(got['CETES']).toBeUndefined()
  }, 60_000)
})

describe.skipIf(SKIP)('Blend still liquidates against its own oracle', () => {
  it('reads the pool oracle from the pool config, not from the Reflector constant', async () => {
    // The single most important guard in this work. A health factor
    // computed from Reflector would disagree with the contract that can
    // seize the collateral, and the disagreement would look like a better
    // number.
    const poolOracle = await readOracleId()

    expect(poolOracle).not.toBe(REFLECTOR_CEX_DEX)
    expect(poolOracle).toMatch(/^C[A-Z0-9]{55}$/)
  }, 60_000)
})
