import { describe, expect, it } from 'vitest'

import { fetchOpenOffers, fillProgress, type HorizonOfferRecord } from '../swap/offers'

/**
 * Resting orders, read from the ledger rather than remembered by the app.
 *
 * The same discipline `history.ts` already applies to settled swaps: the
 * network holds the truth and this app is a view of it. An offer the app
 * "remembers" placing is a claim; an offer Horizon returns is a fact.
 *
 * It also gives partial fills for free. An offer whose remaining amount is
 * below what it was placed at has traded some of the way, and no bookkeeping
 * on our side is needed to notice.
 */

function record(over: Partial<HorizonOfferRecord> = {}): HorizonOfferRecord {
  return {
    id: '8224',
    seller: 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX',
    selling: { asset_type: 'native' },
    buying: {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
    amount: '58.3143655',
    price: '9.2592593',
    last_modified_ledger: 4_578_890,
    ...over,
  }
}

function stubFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }) as Response) as unknown as typeof fetch
}

describe('reading open offers', () => {
  it('maps a resting offer to something the UI can show', async () => {
    const offers = await fetchOpenOffers('GABC', {
      fetchImpl: stubFetch({ _embedded: { records: [record()] } }),
    })

    expect(offers).toHaveLength(1)
    expect(offers[0]?.id).toBe('8224')
    expect(offers[0]?.sellingAsset).toBe('XLM')
    expect(offers[0]?.buyingAsset).toBe('USDC')
    expect(offers[0]?.remaining).toBe('58.3143655')
  })

  it('returns nothing for an account with no offers', async () => {
    const offers = await fetchOpenOffers('GABC', {
      fetchImpl: stubFetch({ _embedded: { records: [] } }),
    })
    expect(offers).toEqual([])
  })

  it('treats an account that does not exist as having no offers', async () => {
    // Unfunded accounts 404 on Stellar. That is not an error, it is an answer.
    const notFound = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as typeof fetch

    await expect(fetchOpenOffers('GABC', { fetchImpl: notFound })).resolves.toEqual([])
  })

  it('reports an unreachable network rather than inventing an empty list', async () => {
    // An empty list means "you have no resting orders", which is a very
    // different claim from "the network could not be reached".
    const broken = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    await expect(fetchOpenOffers('GABC', { fetchImpl: broken })).rejects.toThrow()
  })

  it('finds one offer by id', async () => {
    const offers = await fetchOpenOffers('GABC', {
      fetchImpl: stubFetch({
        _embedded: { records: [record({ id: '1' }), record({ id: '2' })] },
      }),
    })
    expect(offers.map((o) => o.id)).toEqual(['1', '2'])
  })
})

describe('fill progress', () => {
  it('knows an untouched offer has not traded', () => {
    expect(fillProgress({ placed: '100', remaining: '100' })).toEqual({
      filled: '0',
      filledPct: 0,
      partial: false,
    })
  })

  it('measures a partial fill', () => {
    // The live offer observed while planning: 58.31 left of 100.
    const progress = fillProgress({ placed: '100', remaining: '58.3143655' })
    expect(progress.filled).toBe('41.6856345')
    expect(progress.partial).toBe(true)
    expect(progress.filledPct).toBeCloseTo(41.69, 1)
  })

  it('treats a vanished offer as fully filled', () => {
    expect(fillProgress({ placed: '100', remaining: '0' })).toEqual({
      filled: '100',
      filledPct: 100,
      partial: false,
    })
  })

  it('does not report negative progress when the placed size is unknown', () => {
    // Reading an offer placed elsewhere, with no record of its original size.
    const progress = fillProgress({ placed: undefined, remaining: '58.3143655' })
    expect(progress.filledPct).toBe(0)
    expect(progress.partial).toBe(false)
  })
})
