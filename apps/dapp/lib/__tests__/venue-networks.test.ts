import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildMarketContext } from '../agents/market-context'
import { configuredLendingVenues } from '../lend/venues'
import { buildAquariusSwap } from '../swap/build-aquarius'
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
  it('is Soroswap, the classic DEX, the liquidity pools and Soroban Domains', () => {
    const ids = venuesOn('mainnet')
      .filter((v) => v.family === 'stellar')
      .map((v) => v.id)
      .sort()
    expect(ids).toEqual(['sorobandomains', 'soroswap', 'stellar-pools', 'stellarx'].sort())
  })

  it('keeps every Stellar venue on testnet', () => {
    for (const v of stellar) {
      expect(isVenueOn(v, 'testnet'), `${v.id} should be on testnet`).toBe(true)
    }
  })

  it('treats an absent networks field as testnet only', () => {
    expect(isVenueOn({}, 'testnet')).toBe(true)
    expect(isVenueOn({}, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('aquarius')!, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('blend')!, 'mainnet')).toBe(false)
  })

  it('labels a Stellar venue that is not on mainnet, and only there', () => {
    expect(notOnNetworkLabel(byId('aquarius')!, 'mainnet')).toBe('Not on mainnet yet')
    expect(notOnNetworkLabel(byId('soroswap')!, 'mainnet')).toBeUndefined()
    expect(notOnNetworkLabel(byId('aquarius')!, 'testnet')).toBeUndefined()
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
    expect(ids).toEqual(['soroswap', 'stellar-pools', 'stellarx'])
  })

  it('is unchanged on testnet', () => {
    const ids = buildMarketContext('stellar', {}, 'testnet').venues.map((v) => v.id)
    expect(ids).toContain('aquarius')
    expect(ids).toContain('soroswap-aggregator')
    expect(ids).toContain('blend')
    expect(ids).toContain('etherfuse')
    expect(ids).toEqual(buildMarketContext('stellar', {}).venues.map((v) => v.id))
  })

  it('offers no lending venue on mainnet yet', () => {
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'mainnet')).toEqual([])
    expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'testnet')).toEqual([
      'blend',
      'defindex',
    ])
  })
})

describe('nothing is built against a venue that is not here', () => {
  it('passes for a venue on the network and refuses one that is not, by name', () => {
    expect(() => assertVenueOn('soroswap', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'testnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'mainnet')).toThrow('Aquarius is not on mainnet yet')
    expect(() => assertVenueOn('blend', 'mainnet')).toThrow('Blend Capital is not on mainnet yet')
    // An id nobody listed is not a venue at all, and is refused the same way.
    expect(() => assertVenueOn('phoenix', 'testnet')).toThrow('phoenix is not on testnet yet')
  })

  it('stops the Aquarius builder on mainnet before it reads the network', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    await expect(
      buildAquariusSwap({
        account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        from: { kind: 'classic', code: 'XLM' },
        to: { kind: 'classic', code: 'USDC', issuer: 'G' },
        sendAmount: '1',
        minReceive: '1',
        poolIndex: '00',
        fetchImpl: () => Promise.reject(new Error('must not be called')),
      })
    ).rejects.toThrow('Aquarius is not on mainnet yet')
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

  it('skips a source whose venue is not on mainnet', async () => {
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
    expect(asked.sort()).toEqual(['horizon', 'soroswap'])
    expect(quotes).toEqual([])
    // Not asked means not failed either: a venue that is not here has no
    // answer to report, and a failure line for it would read as an outage.
    expect(failures.map((f) => f.source).sort()).toEqual(['horizon', 'soroswap'])
  })
})

describe('what the Apps page may call available, decided on the server', () => {
  it('is the venue list, plus MoneyGram once its production domain is named', () => {
    const bare = availableVenueIds('mainnet', {})
    expect(bare.has('soroswap')).toBe(true)
    expect(bare.has('moneygram')).toBe(false)
    expect(bare.has('aquarius')).toBe(false)

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
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
