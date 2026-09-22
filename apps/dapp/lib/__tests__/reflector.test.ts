import { nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { fetchReflectorPrices } from '../prices/reflector'
import { fetchMarketPrices } from '../swap/prices'

/**
 * Reading "what is this worth" from Reflector, without a network.
 *
 * Three things are pinned. That decimals are read rather than assumed — 14
 * here, 7 on Blend's mock, and the wrong one is a 10^7 error that still
 * looks like a price. That a stale reading is absent rather than present.
 * And that the source falls through: when Reflector has nothing, the answer
 * comes from the next source and says so, rather than from a guess dressed
 * as an oracle reading.
 */

type Sim = Pick<rpc.Server, 'simulateTransaction'>

interface FakeFeed {
  decimals: number
  resolution: number
  lastTimestamp: number
  /** Ticker → raw fixed-point price. Anything absent answers null. */
  prices: Record<string, bigint>
}

function fakeReflector(feed: FakeFeed): Sim {
  return {
    async simulateTransaction(tx) {
      const op = (
        tx as {
          operations: {
            func?: { invokeContract?: { functionName?: unknown; args?: xdr.ScVal[] } }
          }[]
        }
      ).operations[0]
      const fn = String(op?.func?.invokeContract?.functionName ?? '')
      const args = op?.func?.invokeContract?.args ?? []

      let retval: xdr.ScVal
      switch (fn) {
        case 'decimals':
          retval = nativeToScVal(feed.decimals, { type: 'u32' })
          break
        case 'resolution':
          retval = nativeToScVal(feed.resolution, { type: 'u32' })
          break
        case 'last_timestamp':
          retval = nativeToScVal(BigInt(feed.lastTimestamp), { type: 'u64' })
          break
        case 'lastprice': {
          const asset = scValToNative(args[0] as xdr.ScVal) as [string, string]
          const raw = asset[0] === 'Other' ? feed.prices[asset[1]] : undefined
          retval =
            raw === undefined
              ? xdr.ScVal.scvVoid()
              : nativeToScVal(
                  { price: raw, timestamp: BigInt(feed.lastTimestamp) },
                  { type: { price: ['symbol', 'i128'], timestamp: ['symbol', 'u64'] } }
                )
          break
        }
        default:
          retval = xdr.ScVal.scvVoid()
      }

      return {
        id: '1',
        latestLedger: 1,
        events: [],
        minResourceFee: '0',
        result: { auth: [], retval },
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse
    },
  }
}

/** Recorded from the live feed on 2026-09-17. */
const LIVE = {
  decimals: 14,
  resolution: 300,
  lastTimestamp: 1789599900,
  prices: { XLM: BigInt('17979762484866'), BTC: BigInt('7563593977758267486') },
}

const NOW = LIVE.lastTimestamp + 225

describe('reading a price at the decimals the oracle declares', () => {
  it('turns 14-decimal fixed point into dollars', async () => {
    const got = await fetchReflectorPrices(['XLM'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: NOW,
    })

    expect(got['XLM']?.usd).toBeCloseTo(0.17979762484866, 10)
    expect(got['XLM']?.source).toBe('reflector')
  })

  it('does not lose digits above 2^53', async () => {
    // BTC's raw price exceeds what a double holds exactly. Dividing as a
    // number first would round the numerator before the division.
    const got = await fetchReflectorPrices(['BTC'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: NOW,
    })

    expect(got['BTC']?.usd).toBeCloseTo(75635.93977758267, 6)
  })

  it('reads the decimals rather than assuming fourteen', async () => {
    // The same raw integer at seven decimals is a different price by 10^7.
    // An oracle that reports 7 must be read at 7.
    const got = await fetchReflectorPrices(['XLM'], {
      serverImpl: fakeReflector({ ...LIVE, decimals: 7, prices: { XLM: BigInt('4200000') } }),
      nowSeconds: NOW,
    })

    expect(got['XLM']?.usd).toBeCloseTo(0.42, 10)
  })

  it('dates the price by the oracle, not the wall clock', async () => {
    const got = await fetchReflectorPrices(['XLM'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: NOW,
    })

    expect(got['XLM']?.asOf).toBe(new Date(LIVE.lastTimestamp * 1000).toISOString())
  })
})

describe('a price the feed does not have is absent, not invented', () => {
  it('skips a ticker the oracle does not list', async () => {
    const got = await fetchReflectorPrices(['XLM', 'CETES'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: NOW,
    })

    expect(got['XLM']).toBeDefined()
    expect(got['CETES']).toBeUndefined()
  })

  it('treats a stale reading as absent', async () => {
    // A feed that stopped updating looks exactly like one that did not.
    // Two missed periods and the price is gone, not merely old.
    const got = await fetchReflectorPrices(['XLM'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: LIVE.lastTimestamp + 300 * 2 + 1,
    })

    expect(got['XLM']).toBeUndefined()
  })

  it('keeps a reading that has missed only one period', async () => {
    const got = await fetchReflectorPrices(['XLM'], {
      serverImpl: fakeReflector(LIVE),
      nowSeconds: LIVE.lastTimestamp + 300 * 2,
    })

    expect(got['XLM']).toBeDefined()
  })

  it('returns nothing at all when the oracle cannot be reached', async () => {
    const dead: Sim = {
      async simulateTransaction() {
        throw new Error('connection refused')
      },
    }

    await expect(fetchReflectorPrices(['XLM'], { serverImpl: dead })).resolves.toEqual({})
  })
})

describe('where Reflector sits in the hierarchy', () => {
  const bookAt = (usd: number): typeof fetch =>
    (async () =>
      new Response(
        JSON.stringify({ bids: [{ price: String(usd) }], asks: [{ price: String(usd) }] })
      )) as unknown as typeof fetch

  it('wins over the mainnet book when it has a reading', async () => {
    const prices = await fetchMarketPrices({
      fetchImpl: bookAt(0.196),
      reflectorOptions: { serverImpl: fakeReflector(LIVE), nowSeconds: NOW },
    })

    expect(prices['XLM']?.source).toBe('reflector')
    expect(prices['XLM']?.usd).toBeCloseTo(0.1798, 4)
  })

  it('falls through to the mainnet book when it has nothing', async () => {
    const prices = await fetchMarketPrices({
      fetchImpl: bookAt(0.196),
      reflectorOptions: { serverImpl: fakeReflector({ ...LIVE, prices: {} }), nowSeconds: NOW },
    })

    expect(prices['XLM']?.source).toBe('stellar-mainnet')
    expect(prices['XLM']?.usd).toBeCloseTo(0.196, 6)
  })

  it('falls through to the mainnet book when it is stale', async () => {
    const prices = await fetchMarketPrices({
      fetchImpl: bookAt(0.196),
      reflectorOptions: { serverImpl: fakeReflector(LIVE), nowSeconds: NOW + 100_000 },
    })

    expect(prices['XLM']?.source).toBe('stellar-mainnet')
  })

  it('reaches the labelled fallback only when every source is gone', async () => {
    const dead: Sim = {
      async simulateTransaction() {
        throw new Error('down')
      },
    }
    const noBook = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch

    const prices = await fetchMarketPrices({
      fetchImpl: noBook,
      reflectorOptions: { serverImpl: dead },
    })

    expect(prices['XLM']?.source).toBe('fallback')
  })

  it('can be told to skip the oracle, so the book path stays testable alone', async () => {
    const prices = await fetchMarketPrices({ fetchImpl: bookAt(0.196), reflector: false })
    expect(prices['XLM']?.source).toBe('stellar-mainnet')
  })

  it('still prices USDC at one dollar by construction', async () => {
    // The quote asset. Looking it up would add a lookup that can only
    // introduce error.
    const prices = await fetchMarketPrices({
      fetchImpl: bookAt(0.196),
      reflectorOptions: { serverImpl: fakeReflector(LIVE), nowSeconds: NOW },
    })

    expect(prices['USDC']?.usd).toBe(1)
  })
})
