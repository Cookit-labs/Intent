import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildMarketContext } from '../agents/market-context'
import { configuredLendingVenues } from '../lend/venues'
import { collectQuotes, type QuoteSource } from '../swap/quote'
import {
  assertVenueOn,
  availableVenueIds,
  isVenueOn,
  notOnNetworkLabel,
  venues,
  venuesOn,
} from '../venues'

/**
 * Which venues exist on which network.
 *
 * A venue is wired in against testnet first, and its mainnet contracts are a
 * separate act of verification. Until that act, the venue is testnet-only:
 * the agents are not offered it, no quote is asked of it, and the Apps page
 * says so quietly rather than claiming an integration that would fail at
 * signing. Absent `networks` means testnet only — the safe default, since
 * claiming mainnet by omission is the wrong way round.
 *
 * The launch set on mainnet is deliberately small: Soroswap, the classic
 * DEX, the network's own liquidity pools, and Soroban Domains for names.
 */

const byId = (id: string) => venues.find((v) => v.id === id)
const stellar = venues.filter((v) => v.family === 'stellar')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('which venues are on mainnet at launch', () => {
  it('is every venue whose mainnet contracts are verified in the code', () => {
    const ids = venuesOn('mainnet')
      .filter((v) => v.family === 'stellar')
      .map((v) => v.id)
      .sort()
    expect(ids).toEqual(
      [
        'aquarius',
        'blend',
        'etherfuse',
        'sorobandomains',
        'soroswap',
        'soroswap-aggregator',
        'stellar-pools',
        'stellarx',
      ].sort()
    )
  })

  it('keeps every Stellar venue on testnet', () => {
    for (const v of stellar) {
      expect(isVenueOn(v, 'testnet'), `${v.id} should be on testnet`).toBe(true)
    }
  })

  it('treats an absent networks field as testnet only', () => {
    expect(isVenueOn({}, 'testnet')).toBe(true)
    expect(isVenueOn({}, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('noether')!, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('defindex')!, 'mainnet')).toBe(false)
  })

  it('labels a Stellar venue that is not on mainnet, and only there', () => {
    expect(notOnNetworkLabel(byId('noether')!, 'mainnet')).toBe('Not on mainnet yet')
    expect(notOnNetworkLabel(byId('soroswap')!, 'mainnet')).toBeUndefined()
    expect(notOnNetworkLabel(byId('noether')!, 'testnet')).toBeUndefined()
    // An EVM venue is on another chain entirely; the Stellar flag says
    // nothing about it.
    expect(notOnNetworkLabel(byId('uniswap')!, 'mainnet')).toBeUndefined()
  })
})

describe('what the agents are offered', () => {
  it('lists only the mainnet venues on mainnet', () => {
    const ids = buildMarketContext('stellar', {}, 'mainnet')
      .venues.map((v) => v.id)
      .sort()
    expect(ids).toEqual([
      'aquarius',
      'blend',
      'etherfuse',
      'soroswap',
      'soroswap-aggregator',
      'stellar-pools',
      'stellarx',
    ])
  })

  it('is unchanged on testnet', () => {
    const ids = buildMarketContext('stellar', {}, 'testnet').venues.map((v) => v.id)
    expect(ids).toContain('aquarius')
    expect(ids).toContain('soroswap-aggregator')
    expect(ids).toContain('blend')
    expect(ids).toContain('etherfuse')
    expect(ids).toEqual(buildMarketContext('stellar', {}).venues.map((v) => v.id))
  })

  it('offers Blend on mainnet, and DeFindex only on testnet', () => {
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'mainnet')).toEqual(['blend'])
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'testnet')).toEqual([
      'blend',
      'defindex',
    ])
  })
})

describe('nothing is built against a venue that is not here', () => {
  it('passes for a venue on the network and refuses one that is not, by name', () => {
    expect(() => assertVenueOn('soroswap', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('blend', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'testnet')).not.toThrow()
    expect(() => assertVenueOn('etherfuse', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('noether', 'mainnet')).toThrow('Noether is not on mainnet yet')
    expect(() => assertVenueOn('defindex', 'mainnet')).toThrow('DeFindex is not on mainnet yet')
    // An id nobody listed is not a venue at all, and is refused the same way.
    expect(() => assertVenueOn('phoenix', 'testnet')).toThrow('phoenix is not on testnet yet')
  })
})

describe('a flagged venue with no verified contract stays off the allowlist', () => {
  it('has no Noether contract on mainnet even though the registry lists it', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const { NOETHER_MARKET, lookupContract } = await import('../swap/contract-registry')
    expect(NOETHER_MARKET).toBeUndefined()
    expect(
      lookupContract('CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN')
    ).toBeUndefined()
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})

describe('quote sources follow the venue list', () => {
  function source(id: QuoteSource['id'], asked: string[]): QuoteSource {
    return {
      id,
      displayName: id,
      isConfigured: () => true,
      quote: async () => {
        asked.push(id)
        return { ok: false, failure: { source: id, reason: 'no_route' } }
      },
    }
  }

  const req = {
    kind: 'strict_send' as const,
    from: { kind: 'classic' as const, code: 'XLM' },
    to: { kind: 'classic' as const, code: 'USDC', issuer: 'G' },
    sendAmount: '1',
  }

  it('asks every configured source on testnet', async () => {
    const asked: string[] = []
    await collectQuotes(
      [source('horizon', asked), source('aquarius', asked), source('soroswap', asked)],
      req
    )
    expect(asked.sort()).toEqual(['aquarius', 'horizon', 'soroswap'])
  })

  it('asks every source whose venue is on mainnet', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const asked: string[] = []
    const { quotes, failures } = await collectQuotes(
      [
        source('horizon', asked),
        source('aquarius', asked),
        source('soroswap', asked),
        source('soroswap-aggregator', asked),
      ],
      req
    )
    expect(asked.sort()).toEqual(['aquarius', 'horizon', 'soroswap', 'soroswap-aggregator'])
    expect(quotes).toEqual([])
    expect(failures.map((f) => f.source).sort()).toEqual([
      'aquarius',
      'horizon',
      'soroswap',
      'soroswap-aggregator',
    ])
  })
})

describe('what the Apps page may call available, decided on the server', () => {
  it('is the venue list, plus MoneyGram once its production domain is named', () => {
    const bare = availableVenueIds('mainnet', {})
    expect(bare.has('soroswap')).toBe(true)
    expect(bare.has('moneygram')).toBe(false)
    expect(bare.has('aquarius')).toBe(true)
    expect(bare.has('etherfuse')).toBe(true)
    expect(bare.has('noether')).toBe(false)

    const configured = availableVenueIds('mainnet', {
      MONEYGRAM_PRODUCTION_HOME_DOMAIN: 'stellar.moneygram.com',
    })
    expect(configured.has('moneygram')).toBe(true)
    expect(configured.has('testanchor')).toBe(false)
  })

  it('has every Stellar venue on testnet', () => {
    const ids = availableVenueIds('testnet', {})
    for (const v of stellar) expect(ids.has(v.id), v.id).toBe(true)
  })

  it('labels by that decision, not by the static list alone', () => {
    const moneygram = byId('moneygram')!
    expect(notOnNetworkLabel(moneygram, 'mainnet', true)).toBeUndefined()
    expect(notOnNetworkLabel(moneygram, 'mainnet', false)).toBe('Not on mainnet yet')
  })
})

describe('venue copy on mainnet', () => {
  it('does not say the payment settles on testnet', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const { venues: onMainnet } = await import('../venues')
    const names = onMainnet.find((v) => v.id === 'sorobandomains')
    expect(names?.capability).toMatch(/mainnet/i)
    expect(names?.capability).not.toMatch(/testnet/i)
    // KTB has no market on mainnet, so its copy must not promise Korean bonds.
    const bonds = onMainnet.find((v) => v.id === 'etherfuse')
    expect(bonds?.capability).toMatch(/CETES, USTRY/)
    expect(bonds?.capability).not.toMatch(/Korean/)
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
