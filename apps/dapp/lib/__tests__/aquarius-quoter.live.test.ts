import { describe, expect, it } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { createAquariusQuoter } from '../swap/sources/aquarius-quoter'
import { createSoroswapQuoter } from '../swap/sources/soroswap-quoter'

/**
 * Aquarius, live on testnet, beside Soroswap.
 *
 * Live rather than mocked because the three things most likely to be wrong —
 * the `u128` encoding, the sorted token vector, and the pool-index shape —
 * all fail in ways a fixture written from this module's own assumptions
 * would never see. Only the real router refuses an unsorted pair or an
 * `i128`.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'

const XLM = resolveAsset('XLM')
const USDC = resolveAsset('USDC')
if (XLM === undefined || USDC === undefined) throw new Error('registry missing XLM or USDC')

describe.skipIf(SKIP)('quoting Aquarius', () => {
  const aquarius = createAquariusQuoter()

  it('finds every pool for the pair, not only one', async () => {
    // XLM/USDC had three pools when this was written. A quoter that found
    // one would present a single price as the venue's answer when the venue
    // has three, and an agent could not choose between them.
    const all = await aquarius.quoteAll?.({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
    })

    expect(all?.ok).toBe(true)
    if (all?.ok !== true) return
    expect(all.quotes.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('carries the pool index on every quote', async () => {
    const all = await aquarius.quoteAll?.({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
    })
    if (all?.ok !== true) throw new Error('no quotes')

    for (const quote of all.quotes) {
      expect(quote.poolIndex).toMatch(/^[0-9a-f]{64}$/)
    }
    // And they differ: three pools, three indices.
    expect(new Set(all.quotes.map((q) => q.poolIndex)).size).toBe(all.quotes.length)
  }, 60_000)

  it('orders pools best first, so quote() returns the winner', async () => {
    const [all, best] = await Promise.all([
      aquarius.quoteAll?.({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: '200000000' }),
      aquarius.quote({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: '200000000' }),
    ])
    if (all?.ok !== true || !best.ok) throw new Error('no quotes')

    const amounts = all.quotes.map((q) => BigInt(q.destAmount))
    for (let i = 1; i < amounts.length; i += 1) {
      expect((amounts[i - 1] as bigint) >= (amounts[i] as bigint)).toBe(true)
    }
    expect(best.quote.destAmount).toBe(all.quotes[0]?.destAmount)
  }, 60_000)

  it('settles in the asset it names', async () => {
    // `sacFor` derives the canonical contract, which is the classic asset
    // reachable from Soroban. No `deliversAsset` means no substitution.
    const best = await aquarius.quote({
      kind: 'strict_send',
      from: USDC,
      to: XLM,
      sendAmount: '200000000',
    })
    if (!best.ok) throw new Error('no quote')

    expect(best.quote.deliversAsset).toBeUndefined()
    expect(best.quote.source).toBe('aquarius')
  }, 60_000)

  it('declines a fixed-output request rather than guessing', async () => {
    const got = await aquarius.quote({
      kind: 'strict_receive',
      from: USDC,
      to: XLM,
      receiveAmount: '1000000000',
    })

    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.failure.reason).toBe('unsupported_pair')
  }, 30_000)
})

describe.skipIf(SKIP)('Aquarius beside Soroswap', () => {
  it('each router prices each direction on its own', async () => {
    // Which venue wins is the market's answer and changes with it: this test
    // used to require each venue to win one direction, and failed the day one
    // venue won both. Nothing depended on that. What the race does depend on is
    // that both routers answer for both directions, in their own name, with an
    // amount worth comparing.
    const aquarius = createAquariusQuoter()
    const soroswap = createSoroswapQuoter()

    const [aquaBuy, soroBuy, aquaSell, soroSell] = await Promise.all([
      aquarius.quote({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: '200000000' }),
      soroswap.quote({ kind: 'strict_send', from: USDC, to: XLM, sendAmount: '200000000' }),
      aquarius.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '1000000000' }),
      soroswap.quote({ kind: 'strict_send', from: XLM, to: USDC, sendAmount: '1000000000' }),
    ])

    if (!aquaBuy.ok || !soroBuy.ok || !aquaSell.ok || !soroSell.ok) {
      throw new Error('a venue did not quote')
    }

    expect(aquaBuy.quote.source).toBe('aquarius')
    expect(aquaSell.quote.source).toBe('aquarius')
    expect(soroBuy.quote.source).toBe('soroswap')
    expect(soroSell.quote.source).toBe('soroswap')

    for (const quote of [aquaBuy, soroBuy, aquaSell, soroSell]) {
      expect(BigInt(quote.quote.destAmount) > BigInt(0)).toBe(true)
    }
  }, 90_000)
})
