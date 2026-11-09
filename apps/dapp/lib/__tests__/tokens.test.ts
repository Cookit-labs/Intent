import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../../app/api/chain/[chain]/tokens/route'
import { asksAboutTokens } from '../tokens/ask'
import { resetTokenCache, searchTokens, tokenDetail, tokenDirectory } from '../tokens/directory'
import type { ReadJson } from '../tokens/sources'
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

  it('drops an icon that is not plain https', async () => {
    const { read } = router({
      toporganicscore: [{ ...jup('X', 'X', false), icon: 'javascript:alert(1)' }],
      'search?query': [],
    })
    const { tokens } = await tokenDirectory('solana', read)
    expect(tokens.find((t) => t.id === 'X')?.icon).toBeUndefined()
  })
})

describe('tokens through GeckoTerminal', () => {
  const pools = {
    included: [
      { type: 'token', attributes: { address: '0x2::sui::SUI' } },
      { type: 'token', attributes: { address: '0xother::t::T' } },
      { type: 'dex', attributes: {} },
    ],
  }

  it('lists the tokens in the busiest pools with what this app trades first', async () => {
    const { read } = router({
      '/pools?page': pools,
      '/tokens/multi/': {
        data: [
          gecko('0xother::t::T', 'T', { total_reserve_in_usd: '9000' }),
          gecko('0x2::sui::SUI', 'SUI', { coingecko_coin_id: 'sui' }),
        ],
      },
      '/info': { data: { attributes: { holders: { count: 777 } } } },
      'api.dexscreener.com': [],
    })
    const { tokens, sources } = await tokenDirectory('sui', read)
    expect(sources).toContain('GeckoTerminal')
    expect(tokens[0]?.listed).toBe(true)
    const sui = tokens.find((t) => t.symbol === 'SUI')
    expect(sui?.verified).toEqual(['Checked by Intent, and tradable here', 'Listed on CoinGecko'])
    expect(sui?.holders).toBe(777)
    expect(sui?.explorerUrl).toBe('https://suiscan.xyz/mainnet/coin/0x2::sui::SUI')
    expect(tokens.find((t) => t.symbol === 'T')?.liquidityUsd).toBe(9000)
  })

  it('asks for holders of only a few tokens, and stops at the first refusal', async () => {
    let calls = 0
    const { read } = router({
      '/pools?page': pools,
      '/tokens/multi/': { data: [] },
      '/info': () => {
        calls += 1
        return new Error('429')
      },
      'api.dexscreener.com': [],
    })
    await tokenDirectory('sui', read)
    expect(calls).toBe(1)
  })

  it('falls back to DexScreener when GeckoTerminal is busy', async () => {
    const { read } = router({
      '/pools?page': new Error('429'),
      '/tokens/multi/': new Error('429'),
      '/info': new Error('429'),
      '/tokens/v1/sui/': [
        {
          baseToken: { address: SUI_USDC, symbol: 'USDC', name: 'USD Coin' },
          priceUsd: '1',
          marketCap: 100,
          liquidity: { usd: 50 },
          volume: { h24: 25 },
          priceChange: { h24: 0.5 },
        },
      ],
    })
    const { tokens, sources, partial } = await tokenDirectory('sui', read)
    expect(sources).toEqual(['DexScreener'])
    expect(partial).toBe(true)
    expect(tokens.find((t) => t.symbol === 'USDC')).toMatchObject({
      liquidityUsd: 50,
      volume24hUsd: 25,
      change24h: 0.5,
    })
  })

  it('reads a native coin through its wrapped form, under its own name', async () => {
    const { read, asked } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': { data: [gecko(WMON, 'WMON', { total_reserve_in_usd: '42' })] },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
    })
    const { tokens } = await tokenDirectory('monad', read)
    expect(asked.some((u) => u.includes('/tokens/multi/'))).toBe(true)
    const mon = tokens.find((t) => t.symbol === 'MON')
    expect(mon?.listed).toBe(true)
    expect(mon?.liquidityUsd).toBe(42)
  })

  it('gives a native coin its whole market cap, never what happens to be wrapped', async () => {
    const { read } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': {
        data: [gecko(WMON, 'WMON', { market_cap_usd: '6000000', fdv_usd: '6000000' })],
      },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
      'api.coingecko.com': { monad: { usd: 0.02, usd_market_cap: 900000000 } },
    })
    const mon = (await tokenDirectory('monad', read)).tokens.find((t) => t.symbol === 'MON')
    expect(mon?.marketCapUsd).toBe(900000000)
    expect(mon?.fdvUsd).toBeUndefined()
  })

  it('says no market cap for a native coin rather than the wrapped figure', async () => {
    const { read } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': { data: [gecko(WMON, 'WMON', { market_cap_usd: '6000000' })] },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
      'api.coingecko.com': new Error('429'),
    })
    const mon = (await tokenDirectory('monad', read)).tokens.find((t) => t.symbol === 'MON')
    expect(mon?.marketCapUsd).toBeUndefined()
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

  it('keeps the last good answer when every source stops answering', async () => {
    const good = router({
      '/pools?page': pools,
      '/tokens/multi/': { data: [gecko('0x2::sui::SUI', 'SUI')] },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
    })
    const first = await tokenDirectory('sui', good.read, 1_000)
    expect(first.tokens.find((t) => t.symbol === 'SUI')?.priceUsd).toBe(2)
    const later = await tokenDirectory('sui', router({}).read, 1_000 + 10 * 60_000)
    expect(later.partial).toBe(true)
    expect(later.tokens.find((t) => t.symbol === 'SUI')?.priceUsd).toBe(2)
  })

  it('answers from memory within five minutes', async () => {
    const { read, asked } = router({
      '/pools?page': { included: [] },
      '/tokens/multi/': { data: [] },
      '/info': new Error('429'),
      'api.dexscreener.com': [],
    })
    await tokenDirectory('sui', read, 1_000)
    const after = asked.length
    await tokenDirectory('sui', read, 1_000 + 60_000)
    expect(asked.length).toBe(after)
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
