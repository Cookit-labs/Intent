import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../../app/api/chain/[chain]/tokens/route'
import { asksAboutTokens } from '../tokens/ask'
import { resetTokenCache, searchTokens, tokenDetail, tokenDirectory } from '../tokens/directory'
import { dexscreenerTokens, type ReadJson } from '../tokens/sources'
import { changeFigure, countFigure, priceFigure, usdFigure } from '../tokens/types'

vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))

const SUI_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a'

function gecko(address: string, symbol: string, over: Record<string, unknown> = {}) {
  return {
    attributes: {
      address,
      symbol,
      name: `${symbol} name`,
      price_usd: '2',
      market_cap_usd: '1000',
      fdv_usd: '2000',
      total_reserve_in_usd: '500',
      volume_usd: { h24: '250' },
      coingecko_coin_id: null,
      image_url: null,
      ...over,
    },
  }
}

function router(routes: Record<string, unknown | (() => unknown)>): {
  read: ReadJson
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    read: async (url) => {
      asked.push(url)
      for (const [part, answer] of Object.entries(routes)) {
        if (!url.includes(part)) continue
        const value = typeof answer === 'function' ? (answer as () => unknown)() : answer
        if (value instanceof Error) throw value
        return value
      }
      throw new Error(`no route for ${url}`)
    },
  }
}

beforeEach(() => resetTokenCache())

describe('how figures read', () => {
  it('shrinks dollars and counts, and never calls unknown zero', () => {
    expect(usdFigure(1_234_567)).toBe('$1.23M')
    expect(usdFigure(70_000_000_000)).toBe('$70B')
    expect(usdFigure(undefined)).toBe('—')
    expect(usdFigure(0)).toBe('$0')
    expect(countFigure(165_866)).toBe('165.87K')
    expect(countFigure(undefined)).toBe('—')
  })

  it('keeps the digits of a small price', () => {
    expect(priceFigure(86.5)).toBe('$86.50')
    expect(priceFigure(0.5)).toBe('$0.50')
    expect(priceFigure(0.1234)).toBe('$0.1234')
    expect(priceFigure(0.00001234)).toBe('$0.00001234')
    expect(priceFigure(64000)).toBe('$64,000')
    expect(priceFigure(undefined)).toBe('—')
  })

  it('signs a change', () => {
    expect(changeFigure(2.5)).toBe('+2.50%')
    expect(changeFigure(-1)).toBe('-1.00%')
    expect(changeFigure(-0.001)).toBe('0.00%')
    expect(changeFigure(undefined)).toBe('—')
  })
})

describe('tokens on Solana', () => {
  const jup = (id: string, symbol: string, isVerified: boolean) => ({
    id,
    symbol,
    name: symbol,
    icon: 'https://example.com/a.png',
    usdPrice: 1,
    mcap: 10,
    fdv: 20,
    liquidity: 30,
    holderCount: 40,
    isVerified,
    stats24h: { buyVolume: 5, sellVolume: 6, priceChange: -1.5 },
  })

  it('reads every figure and who verified it from Jupiter', async () => {
    const { read } = router({
      toporganicscore: [jup('MEME', 'MEME', false)],
      'search?query': [jup(SOL_USDC, 'USDC', true)],
    })
    const { tokens, sources, partial } = await tokenDirectory('solana', read)
    expect(sources).toEqual(['Jupiter'])
    expect(partial).toBe(false)
    const usdc = tokens.find((t) => t.id === SOL_USDC)
    expect(usdc).toMatchObject({
      symbol: 'USDC',
      marketCapUsd: 10,
      fdvUsd: 20,
      liquidityUsd: 30,
      holders: 40,
      volume24hUsd: 11,
      change24h: -1.5,
      listed: true,
      explorerUrl: `https://solscan.io/token/${SOL_USDC}`,
    })
    expect(usdc?.verified).toEqual(['Checked by Intent, and tradable here', 'Verified by Jupiter'])
    expect(tokens.find((t) => t.id === 'MEME')?.verified).toEqual([])
  })

  it('flags a token using the name of one this app lists, at another address', async () => {
    const { read } = router({
      toporganicscore: [jup('FAKE', 'USDC', false)],
      'search?query': [],
    })
    const { tokens } = await tokenDirectory('solana', read)
    expect(tokens.find((t) => t.id === 'FAKE')).toMatchObject({
      sameNameAs: 'USDC',
      listed: false,
      verified: [],
    })
  })

  it('still lists what can be traded here when Jupiter answers nothing', async () => {
    const { read } = router({})
    const { tokens, partial } = await tokenDirectory('solana', read)
    expect(partial).toBe(true)
    expect(tokens.some((t) => t.symbol === 'SOL' && t.listed)).toBe(true)
    expect(tokens.find((t) => t.symbol === 'SOL')?.priceUsd).toBeUndefined()
  })

  it('shows no market cap where a source answers zero', async () => {
    const { read } = router({
      toporganicscore: [{ ...jup('ZERO', 'ZERO', false), mcap: 0, fdv: 0 }],
      'search?query': [],
    })
    const { tokens } = await tokenDirectory('solana', read)
    const zero = tokens.find((t) => t.id === 'ZERO')
    expect(zero?.marketCapUsd).toBeUndefined()
    expect(zero?.fdvUsd).toBeUndefined()
  })

  it('uses its own name for what it lists', async () => {
    const SOL = 'So11111111111111111111111111111111111111112'
    const { read } = router({
      toporganicscore: [],
      'search?query': [{ ...jup(SOL, 'SOL', true), name: 'Wrapped SOL' }],
    })
    const { tokens } = await tokenDirectory('solana', read)
    expect(tokens.find((t) => t.symbol === 'SOL')?.name).toBe('Solana')
  })

  it('reads a staked token’s depth from its pools, not the whole stake pool Jupiter counts', async () => {
    const JITO = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
    const { read } = router({
      toporganicscore: [{ ...jup(JITO, 'JitoSOL', true), mcap: 880, liquidity: 880 }],
      'search?query': [],
      'api.dexscreener.com': [dsPair([JITO, 'JitoSOL'], [SOL_USDC, 'USDC'], 25)],
    })
    const jito = (await tokenDirectory('solana', read)).tokens.find((t) => t.id === JITO)
    expect(jito?.liquidityUsd).toBe(25)
    expect(jito?.marketCapUsd).toBe(880)
  })

  it('keeps Jupiter’s depth for a staked token when no pool answers', async () => {
    const JITO = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
    const { read } = router({
      toporganicscore: [{ ...jup(JITO, 'JitoSOL', true), mcap: 880, liquidity: 880 }],
      'search?query': [],
    })
    const jito = (await tokenDirectory('solana', read)).tokens.find((t) => t.id === JITO)
    expect(jito?.liquidityUsd).toBe(880)
  })

  it('drops an icon that is not plain https', async () => {
    const { read } = router({
      toporganicscore: [{ ...jup('X', 'X', false), icon: 'javascript:alert(1)' }],
      'search?query': [],
    })
    const { tokens } = await tokenDirectory('solana', read)
    expect(tokens.find((t) => t.id === 'X')?.icon).toBeUndefined()
  })
})

const SUI_LONG = `0x${'0'.repeat(63)}2::sui::SUI`

function cetusPool(a: [string, string], b: [string, string], tvl: number, vol: number) {
  return {
    pure_tvl_in_usd: String(tvl),
    vol_in_usd_24h: String(vol),
    coin_a: { address: a[0], symbol: a[1], name: a[1], logo_url: 'https://example.com/a.png' },
    coin_b: { address: b[0], symbol: b[1], name: b[1], logo_url: null },
  }
}

function dsPair(base: [string, string], quote: [string, string], liq: number, over = {}) {
  return {
    pairAddress: `${base[0]}-${quote[0]}-${liq}`,
    baseToken: { address: base[0], symbol: base[1] },
    quoteToken: { address: quote[0], symbol: quote[1] },
    priceUsd: '2',
    marketCap: 1000,
    liquidity: { usd: liq },
    volume: { h24: liq / 10 },
    priceChange: { h24: 1.5 },
    ...over,
  }
}

describe('tokens on Sui, from its own apps', () => {
  const T = '0xother::t::T'
  const routes = (over: Record<string, unknown> = {}) => ({
    'api-sui.cetus.zone': {
      data: {
        lp_list: [
          cetusPool([SUI_LONG, 'SUI'], [SUI_USDC, 'USDC'], 1000, 100),
          cetusPool([T, 'T'], [SUI_LONG, 'SUI'], 500, 50),
        ],
      },
    },
    'bluefin.io': [
      { address: '0x2::sui::SUI', isVerified: true },
      { address: T, isVerified: false },
    ],
    '/tokens/v1/sui/': [
      dsPair(['0x2::sui::SUI', 'SUI'], [SUI_USDC, 'USDC'], 9_999_999),
      dsPair([T, 'T'], ['0x2::sui::SUI', 'SUI'], 1),
    ],
    '/info': { data: { attributes: { holders: { count: 777 } } } },
    ...over,
  })

  it('takes depth from Cetus, price from DexScreener, and the tick from Bluefin', async () => {
    const { tokens, sources } = await tokenDirectory('sui', router(routes()).read)
    expect(sources).toEqual(['Cetus', 'Bluefin', 'DexScreener'])
    const sui = tokens.find((t) => t.symbol === 'SUI')
    expect(sui).toMatchObject({
      id: '0x2::sui::SUI',
      listed: true,
      liquidityUsd: 1500,
      volume24hUsd: 150,
      priceUsd: 2,
      change24h: 1.5,
      explorerUrl: 'https://suiscan.xyz/mainnet/coin/0x2::sui::SUI',
    })
    expect(sui?.verified).toEqual(['Checked by Intent, and tradable here', 'Verified by Bluefin'])
    expect(tokens.find((t) => t.symbol === 'T')?.verified).toEqual([])
  })

  it('counts holders through GeckoTerminal, a few at a time, stopping at a refusal', async () => {
    let calls = 0
    const { read } = router(
      routes({
        '/info': () => {
          calls += 1
          return new Error('429')
        },
      })
    )
    await tokenDirectory('sui', read)
    expect(calls).toBe(1)
  })

  it('leaves out tokens nothing priced, but never one this app trades', async () => {
    const { tokens } = await tokenDirectory(
      'sui',
      router(routes({ '/tokens/v1/sui/': [], '/info': new Error('429') })).read
    )
    expect(tokens.some((t) => t.symbol === 'T')).toBe(false)
    expect(tokens.some((t) => t.symbol === 'SUI' && t.listed)).toBe(true)
  })

  it('keeps the last good answer when every source stops answering', async () => {
    const first = await tokenDirectory('sui', router(routes()).read, 1_000)
    expect(first.tokens.find((t) => t.symbol === 'SUI')?.priceUsd).toBe(2)
    const later = await tokenDirectory('sui', router({}).read, 1_000 + 10 * 60_000)
    expect(later.partial).toBe(true)
    expect(later.tokens.find((t) => t.symbol === 'SUI')?.priceUsd).toBe(2)
  })

  it('answers from memory within five minutes', async () => {
    const { read, asked } = router(routes())
    await tokenDirectory('sui', read, 1_000)
    const after = asked.length
    await tokenDirectory('sui', read, 1_000 + 60_000)
    expect(asked.length).toBe(after)
  })

  it('asks again soon after a partial answer, not five minutes later', async () => {
    const busy = router({})
    await tokenDirectory('sui', busy.read, 1_000)
    const after = busy.asked.length
    await tokenDirectory('sui', busy.read, 1_000 + 30_000)
    expect(busy.asked.length).toBe(after)
    await tokenDirectory('sui', busy.read, 1_000 + 61_000)
    expect(busy.asked.length).toBeGreaterThan(after)
  })
})

describe('tokens on NEAR, from its own apps', () => {
  it('ranks by NEARBlocks, ticks what NEAR Intents routes, and counts holders there', async () => {
    const { read } = router({
      'api.nearblocks.io/v1/fts?': {
        tokens: [
          {
            contract: 'usdt.tether-token.near',
            symbol: 'USDt',
            name: 'Tether USD',
            price: '1',
            onchain_market_cap: '500',
            market_cap: '99999999999',
            volume_24h: '99999999999',
            change_24: '-0.1',
            icon: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
          },
          { contract: 'meme.near', symbol: 'MEME', price: '0.1', onchain_market_cap: '5' },
        ],
      },
      '1click.chaindefuser.com': [
        { blockchain: 'near', contractAddress: 'usdt.tether-token.near' },
        { blockchain: 'sol', contractAddress: 'meme.near' },
      ],
      '/tokens/v1/near/': [dsPair(['usdt.tether-token.near', 'USDt'], ['wrap.near', 'wNEAR'], 600)],
      '/holders/count': { holders: [{ count: '2496781' }] },
      'api.coingecko.com': { near: { usd_market_cap: 4_000_000_000 } },
    })
    const { tokens, sources } = await tokenDirectory('near', read)
    expect(sources).toEqual(['NEARBlocks', 'NEAR Intents', 'DexScreener'])
    const usdt = tokens.find((t) => t.id === 'usdt.tether-token.near')
    expect(usdt).toMatchObject({
      marketCapUsd: 500,
      liquidityUsd: 600,
      volume24hUsd: 60,
      holders: 2496781,
      icon: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
    })
    expect(usdt?.verified).toContain('Listed on NEAR Intents')
    expect(tokens.find((t) => t.id === 'meme.near')?.verified).toEqual([])
  })
})

describe('tokens on Avalanche, from its own apps', () => {
  it('lists what LFJ lists, priced by DexScreener, with holders from Routescan', async () => {
    const LFJ_TOKEN = '0x00000000000000000000000000000000000000aa'
    const { read, asked } = router({
      'joe-tokenlists': {
        tokens: [
          {
            chainId: 43114,
            address: LFJ_TOKEN.toUpperCase().replace('0X', '0x'),
            symbol: 'JOE',
            logoURI: 'https://example.com/joe.png',
          },
          { chainId: 43113, address: '0xtestnet', symbol: 'TEST' },
        ],
      },
      '/tokens/v1/avalanche/': [dsPair([LFJ_TOKEN, 'JOE'], ['0xusdc', 'USDC'], 300)],
      'api.routescan.io': { count: 4242 },
      'api.coingecko.com': new Error('429'),
    })
    const { tokens } = await tokenDirectory('avalanche', read)
    const joe = tokens.find((t) => t.symbol === 'JOE')
    expect(joe).toMatchObject({
      liquidityUsd: 300,
      holders: 4242,
      icon: 'https://example.com/joe.png',
    })
    expect(joe?.verified).toEqual(['Listed by LFJ'])
    expect(tokens.some((t) => t.symbol === 'TEST')).toBe(false)
    expect(asked.some((u) => u.includes('/43114/erc20/'))).toBe(true)
  })
})

describe('tokens on Monad, from its own apps', () => {
  it('lists Monorail’s chosen tokens under this app’s names, the native coin as itself', async () => {
    const { read } = router({
      'monorail.xyz/v2/tokens/category/official': [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'MON', holders: 0 },
        {
          address: WMON,
          symbol: 'WMON',
          usd_per_token: '0.02',
          holders: 0,
          image_uri: 'https://example.com/wmon.svg',
        },
      ],
      'monorail.xyz/v2/tokens/category/': [],
      'monorail.xyz/v2/token/': { address: WMON, symbol: 'WMON', holders: 92816 },
      '/tokens/v1/monad/': [dsPair([WMON, 'WMON'], ['0xusdc', 'USDC'], 42)],
      'api.coingecko.com': { monad: { usd_market_cap: 900000000 } },
    })
    const { tokens } = await tokenDirectory('monad', read)
    const mon = tokens.find((t) => t.symbol === 'MON')
    expect(mon).toMatchObject({
      listed: true,
      liquidityUsd: 42,
      marketCapUsd: 900000000,
      holders: 92816,
    })
    expect(mon?.fdvUsd).toBeUndefined()
    expect(mon?.verified).toContain('Chosen by Monorail')
  })

  it('says no market cap for a native coin rather than the wrapped figure', async () => {
    const { read } = router({
      'monorail.xyz': [],
      '/tokens/v1/monad/': [
        dsPair([WMON, 'WMON'], ['0xusdc', 'USDC'], 42, { marketCap: 6_000_000 }),
      ],
      'api.coingecko.com': new Error('429'),
    })
    const mon = (await tokenDirectory('monad', read)).tokens.find((t) => t.symbol === 'MON')
    expect(mon?.marketCapUsd).toBeUndefined()
  })
})

describe('depth from DexScreener', () => {
  it('sums every pool a token sits in, quote side included, counting each pool once', async () => {
    const A = '0x00000000000000000000000000000000000000a1'
    const B = '0x00000000000000000000000000000000000000b2'
    const pools = [
      dsPair([A, 'A'], [B, 'B'], 100),
      dsPair([B, 'B'], ['0xother', 'O'], 50, { priceUsd: '9' }),
      dsPair([A, 'A'], [B, 'B'], 100),
    ]
    const rows = await dexscreenerTokens(async () => pools, 'avalanche', [A, B])
    const a = rows.find((r) => r.symbol === 'A')
    const b = rows.find((r) => r.symbol === 'B')
    expect(a?.liquidityUsd).toBe(100)
    expect(b?.liquidityUsd).toBe(150)
    expect(b?.priceUsd).toBe(9)
  })
})

describe('tokens on Stellar', () => {
  it('joins StellarExpert to market figures by contract', async () => {
    const { read } = router({
      'stellar.expert': {
        _embedded: {
          records: [
            {
              asset: 'XLM',
              contract: 'CXLM',
              price: 0.15,
              supply: '10000000000',
              trustlines: { total: 11000000 },
              rating: { average: 10 },
              tomlInfo: { image: 'https://meta.stellar.expert/x.png', name: 'Lumens' },
            },
            { asset: 'ALONE-GISSUER-1', price: 2, supply: '100000000' },
            {
              asset: 'LOW-GISSUER-1',
              price: 0.1,
              trustlines: { total: 5 },
              rating: { average: 2 },
            },
          ],
        },
      },
      '/tokens/multi/': {
        data: [gecko('CXLM', 'XLM', { total_reserve_in_usd: '712', market_cap_usd: '5200' })],
      },
    })
    const { tokens } = await tokenDirectory('stellar', read)
    const xlm = tokens.find((t) => t.id === 'XLM')
    expect(xlm).toMatchObject({
      holders: 11000000,
      liquidityUsd: 712,
      marketCapUsd: 5200,
      listed: true,
      name: 'Lumens',
    })
    expect(xlm?.verified).toContain('Rated 10 of 10 by StellarExpert')
    // Price times all that was issued is a fully diluted value, and is not called a market cap.
    const alone = tokens.find((t) => t.id === 'ALONE:GISSUER')
    expect(alone?.fdvUsd).toBe(20)
    expect(alone?.marketCapUsd).toBeUndefined()
    const low = tokens.find((t) => t.id === 'LOW:GISSUER')
    expect(low?.verified).toEqual([])
  })
})

describe('searching', () => {
  const quiet = {
    '/pools?page': { included: [] },
    '/tokens/multi/': { data: [] },
    '/info': new Error('429'),
    '/tokens/v1/': [],
  }

  it('answers from what is known when the symbol is there', async () => {
    const { read, asked } = router({
      ...quiet,
      '/latest/dex/search': { pairs: [] },
    })
    const { tokens } = await searchTokens('sui', 'wal', read)
    expect(tokens.map((t) => t.symbol)).toEqual(['WAL'])
    expect(asked.some((u) => u.includes('/latest/dex/search'))).toBe(false)
  })

  it('asks DexScreener for something unknown, on this chain only', async () => {
    const pair = (chainId: string, address: string, usd: number) => ({
      chainId,
      baseToken: { address, symbol: 'NEW' },
      liquidity: { usd },
    })
    const { read } = router({
      ...quiet,
      '/latest/dex/search': {
        pairs: [
          pair('sui', '0xnew::n::NEW', 5),
          pair('sui', '0xnew::n::NEW', 9),
          pair('solana', 'S', 99),
        ],
      },
    })
    const { tokens } = await searchTokens('sui', 'new', read)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ id: '0xnew::n::NEW', liquidityUsd: 9, listed: false })
  })
})

describe('one token in full', () => {
  it('adds its holders and pools, deepest first, keeping links to DexScreener only', async () => {
    const { read } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': { data: [gecko(SUI_USDC, 'USDC')] },
      '/info': { data: { attributes: { holders: { count: 12345 } } } },
      '/token-pairs/v1/': [
        {
          dexId: 'cetus',
          baseToken: { symbol: 'USDC' },
          quoteToken: { symbol: 'SUI' },
          liquidity: { usd: 10 },
          volume: { h24: 1 },
          url: 'https://dexscreener.com/sui/abc',
        },
        {
          dexId: '0x8b336e9042Eca9847884220afea73Fed512aD2F7',
          baseToken: { symbol: 'USDC' },
          quoteToken: { symbol: 'T' },
          liquidity: { usd: 99 },
          url: 'https://evil.example/phish',
        },
      ],
      'api.dexscreener.com': [],
    })
    const token = await tokenDetail('sui', SUI_USDC, read)
    expect(token?.holders).toBe(12345)
    expect(token?.pools?.[0]).toEqual({ dex: 'Unnamed pool', pair: 'USDC/T', liquidityUsd: 99 })
    expect(token?.pools?.[1]).toMatchObject({
      dex: 'cetus',
      url: 'https://dexscreener.com/sui/abc',
    })
  })

  it('says nothing for a token nobody knows', async () => {
    const { read } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': { data: [] },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
      '/latest/dex/search': { pairs: [] },
    })
    await expect(tokenDetail('sui', '0xnobody::n::N', read)).resolves.toBeUndefined()
  })
})

describe('the route', () => {
  const ask = (chain: string, query = '') =>
    GET(new Request(`http://x/api/chain/${chain}/tokens${query}`), {
      params: Promise.resolve({ chain }),
    })

  it('refuses a chain with no directory and a query too long', async () => {
    expect((await ask('arc')).status).toBe(404)
    expect((await ask('sui', `?q=${'x'.repeat(65)}`)).status).toBe(400)
    expect((await ask('sui', `?id=${'x'.repeat(201)}`)).status).toBe(400)
  })
})

describe('asking about tokens in chat', () => {
  it.each([
    'list tokens',
    'give me a list of tokens on this chain',
    'show me all the tokens',
    'what tokens are on solana',
    'which tokens are available',
    'can you show the tokens',
    'tokens on sui',
    'token list',
    'list of coins',
    'what coins can i trade here',
    'give me a list of verified tokens',
  ])('"%s" asks for the list', (text) => {
    expect(asksAboutTokens(text)).toEqual({ kind: 'list' })
  })

  it.each([
    ['is WAL verified', 'wal'],
    ['is wal token legit?', 'wal'],
    ['what is the market cap of SUI', 'sui'],
    ["what's the liquidity of cetus", 'cetus'],
    ['market cap and volume of sol', 'sol'],
    ['volume for NEAR', 'near'],
    ['holders of wal', 'wal'],
    ['how many holders does $BONK have', 'bonk'],
    ['WAL market cap', 'wal'],
    ["sui's liquidity", 'sui'],
    ['tell me about jito', 'jito'],
    ['info on the USDC token', 'usdc'],
    ['details for wal', 'wal'],
    ['check the bonk token', 'bonk'],
  ])('"%s" asks about %s', (text, query) => {
    expect(asksAboutTokens(text)).toEqual({ kind: 'token', query })
  })

  it.each([
    'what tokens do i have',
    'show my tokens',
    'list my coins',
    'what is my balance',
    'swap 5 usdc to sol',
    'send 5 usdc to alice.near',
    'tell me about this',
    'what can you do',
    'deposit 5 usdc',
    'what is the market cap of 5',
  ])('"%s" is about something else', (text) => {
    expect(asksAboutTokens(text)).toBeNull()
  })
})

describe('tokens on each Stellar network', () => {
  const asset = (code: string) => ({
    _embedded: { records: [{ asset: code, price: 1, supply: '1000' }] },
  })

  afterEach(async () => {
    const { setNetworkResolver } = await import('@intent/config')
    setNetworkResolver(undefined)
    vi.unstubAllEnvs()
  })

  async function on(network: 'testnet' | 'mainnet'): Promise<void> {
    const { setNetworkResolver } = await import('@intent/config')
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', 'testnet,mainnet')
    setNetworkResolver(() => network)
  }

  it('keeps each network to its own list, whichever was read first', async () => {
    const { read } = router({
      'explorer/public': asset('MAIN-GISSUER-1'),
      'explorer/testnet': asset('TEST-GISSUER-1'),
    })
    await on('testnet')
    const test = await tokenDirectory('stellar', read)
    expect(test.tokens.some((t) => t.symbol === 'TEST')).toBe(true)

    await on('mainnet')
    const main = await tokenDirectory('stellar', read)
    expect(main.tokens.some((t) => t.symbol === 'MAIN')).toBe(true)
    expect(main.tokens.some((t) => t.symbol === 'TEST')).toBe(false)
  })

  it('keeps each network to its own token details', async () => {
    const { read } = router({
      'explorer/public': asset('SAME-GISSUER-1'),
      'explorer/testnet': asset('SAME-GISSUER-1'),
    })
    await on('testnet')
    const test = await tokenDetail('stellar', 'SAME:GISSUER', read)
    await on('mainnet')
    const main = await tokenDetail('stellar', 'SAME:GISSUER', read)
    expect(test?.explorerUrl).toContain('/testnet/')
    expect(main?.explorerUrl).toContain('/public/')
  })
})
