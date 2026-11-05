import { custom, encodeFunctionData, parseAbi, type Address, type TransactionReceipt } from 'viem'
import { avalanche, monad } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { singleRouteNote } from '../agents/chain-race'
import { quoteChainRoutes } from '../agents/chain-routes'
import { chainCapabilities } from '../chains/capabilities'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import { createEvmDeposit } from '../chains/evm/deposit'
import { buildEvmVenues } from '../chains/evm/module'
import { AVALANCHE_TOKENS, EVM_CHAINS, EVM_NATIVE_ID, MONAD_TOKENS } from '../chains/evm/tokens'
import { clearTokenCache } from '../chains/near/oneclick'
import { oneClickAssetId, oneClickOriginVenue } from '../chains/oneclick-origin'
import { parseChainAction } from '../chains/parse-action'
import { assertKnownTokens, prepareChainAction } from '../chains/prepare'
import { chainModule } from '../chains/registry'
import { afterSubmitting, QUOTE_EXPIRED, quoteExpiredBeforeSigning } from '../chains/signing-flow'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainModule,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type SubmitResult,
} from '../chains/types'
import { buildMarketContext } from '../agents/market-context'
import { capabilitySheet } from '../orchestrate/capabilities'
import { venueOnChain, venues } from '../venues'
import { CHAIN_DESCRIPTORS } from '@intent/config'

vi.hoisted(() => {
  process.env['AUTH_SECRET'] = 'x'.repeat(48)
})

vi.mock('../chains/near/quote-signature', () => ({
  verifyQuoteSignature: vi.fn(() => true),
}))
vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))

const rpc = vi.hoisted(() => ({
  tokenBalance: (async () => BigInt(0)) as (token: string, account: string) => Promise<bigint>,
  nativeBalance: (async () => BigInt(0)) as (account: string) => Promise<bigint>,
  waitForReceipt: (async () => {
    throw new Error('no receipt')
  }) as (hash: string) => Promise<unknown>,
  transaction: (async () => ({ value: BigInt(0), input: '0x' })) as (
    hash: string
  ) => Promise<{ value: bigint; input: string }>,
  reads: [] as string[],
}))

// The venue reads through this, so a test decides what the chain says. A test that passes a
// transport gets the real client over it.
vi.mock('../chains/evm/client', async (original) => {
  const actual = await original<typeof import('../chains/evm/client')>()
  const fake = {
    tokenBalance: (token: string, account: string) => rpc.tokenBalance(token, account),
    nativeBalance: (account: string) => rpc.nativeBalance(account),
    waitForReceipt: (hash: string) => {
      rpc.reads.push(hash)
      return rpc.waitForReceipt(hash)
    },
    transaction: (hash: string) => rpc.transaction(hash),
  }
  return {
    ...actual,
    evmClient: (chain: Parameters<typeof actual.evmClient>[0], transport?: never) =>
      transport === undefined ? fake : actual.evmClient(chain, transport),
    realEvmClient: actual.evmClient,
  }
})

const wallet = vi.hoisted(() => ({
  account: { status: 'connected', chainId: 143 } as { status: string; chainId: number | undefined },
  calls: [] as unknown[][],
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => wallet.account,
  switchChain: async (_config: unknown, args: unknown) => {
    wallet.calls.push(['switch', args])
    return { id: 143 }
  },
  sendTransaction: async (_config: unknown, args: unknown) => {
    wallet.calls.push(['send', args])
    return WALLET_HASH
  },
}))
vi.mock('../wagmi.config', () => ({ arcTestnet: { id: 5042002 }, wagmiConfig: {} }))

const WALLET_HASH = `0x${'c'.repeat(64)}`
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const DEPOSIT = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const HASH = `0x${'a'.repeat(64)}`
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

const token = (list: readonly ChainToken[], symbol: string): ChainToken =>
  tokenBySymbol(list, symbol) as ChainToken

const AVAX = token(AVALANCHE_TOKENS, 'AVAX')
const AVAX_USDC = token(AVALANCHE_TOKENS, 'USDC')
const AVAX_USDT = token(AVALANCHE_TOKENS, 'USDT')
const MON = token(MONAD_TOKENS, 'MON')
const MONAD_USDC = token(MONAD_TOKENS, 'USDC')
const USDT0 = token(MONAD_TOKENS, 'USDT0')

const USD_UNITS = BigInt(25_000_000)
const ONE_AND_A_HALF_AVAX = '1500000000000000000'

type Json = Record<string, unknown>

interface Priced {
  decimals: number
  price: number
}

const ASSETS: Record<string, Priced> = {
  'nep245:avax-native': { decimals: 18, price: 20 },
  'nep245:avax-usdc': { decimals: 6, price: 1 },
  'nep245:avax-usdt': { decimals: 6, price: 1 },
  'nep245:monad-native': { decimals: 18, price: 0.04 },
  'nep245:monad-usdc': { decimals: 6, price: 1 },
  'nep245:monad-usdt0': { decimals: 6, price: 1 },
}

function tokenList(): Json[] {
  const priceUpdatedAt = new Date().toISOString()
  const entry = (
    assetId: string,
    blockchain: string,
    symbol: string,
    contractAddress?: string
  ): Json => ({
    assetId,
    blockchain,
    symbol,
    decimals: ASSETS[assetId]?.decimals ?? 6,
    price: ASSETS[assetId]?.price ?? 1,
    priceUpdatedAt,
    ...(contractAddress !== undefined ? { contractAddress } : {}),
  })
  return [
    entry('nep245:avax-native', 'avax', 'AVAX'),
    // 1Click writes these in lower case, and the constants carry a checksum.
    entry('nep245:avax-usdc', 'avax', 'USDC', AVAX_USDC.id.toLowerCase()),
    entry('nep245:avax-usdt', 'avax', 'USDT', AVAX_USDT.id.toLowerCase()),
    entry('nep245:avax-fake', 'avax', 'USDC', OTHER),
    entry('nep245:monad-native', 'monad', 'MON'),
    entry('nep245:monad-usdc', 'monad', 'USDC', MONAD_USDC.id.toLowerCase()),
    entry('nep245:monad-usdt0', 'monad', 'USDT0', USDT0.id.toLowerCase()),
  ]
}

interface Sim {
  tokens: Json[]
  quotes: Json[]
  notified: Json[]
  statuses: (string | undefined)[]
  statusRecipient: string | undefined
  depositAddress: string
}

let sim: Sim

function goodQuote(body: Json): Json {
  const amount = body['amount'] as string
  const from = ASSETS[body['originAsset'] as string] as Priced
  const to = ASSETS[body['destinationAsset'] as string] as Priced
  const micro = (price: number): bigint => BigInt(Math.round(price * 1_000_000))
  const out =
    (BigInt(amount) * micro(from.price) * BigInt(10) ** BigInt(to.decimals)) /
    (micro(to.price) * BigInt(10) ** BigInt(from.decimals))
  const usd = (Number(amount) / 10 ** from.decimals) * from.price
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: 'x',
      amountInUsd: String(usd),
      minAmountIn: amount,
      amountOut: out.toString(),
      amountOutFormatted: 'x',
      amountOutUsd: String(usd * 0.995),
      minAmountOut: ((out * BigInt(99)) / BigInt(100)).toString(),
      ...(body['dry'] === true ? {} : { depositAddress: sim.depositAddress }),
    },
    quoteRequest: body,
    signature: 'ed25519:x',
    timestamp: '2026-11-04T00:00:00.000Z',
  }
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown, status = 200): Response =>
        new Response(JSON.stringify(data), { status })
      if (url.endsWith('/v0/tokens')) return json(sim.tokens)
      if (url.endsWith('/v0/quote')) {
        const body = JSON.parse(init?.body as string) as Json
        sim.quotes.push(body)
        return json(goodQuote(body), 201)
      }
      if (url.endsWith('/v0/deposit/submit')) {
        sim.notified.push(JSON.parse(init?.body as string) as Json)
        return json({ correlationId: 'c' })
      }
      if (url.includes('/v0/status')) {
        const status = sim.statuses.length > 1 ? sim.statuses.shift() : sim.statuses[0]
        return json({ status, quoteResponse: { quoteRequest: { recipient: sim.statusRecipient } } })
      }
      throw new Error(`no live call: ${url}`)
    })
  )
}

const word = (hexDigits: string): string => hexDigits.padStart(64, '0')
const addressWord = (address: string): string => word(address.slice(2).toLowerCase())

function transferLog(
  tokenAddress: string,
  units: bigint,
  change: { from?: string; to?: string } = {}
): TransactionReceipt['logs'][number] {
  return {
    address: tokenAddress,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: BigInt(1),
    data: `0x${word(units.toString(16))}`,
    logIndex: 0,
    removed: false,
    topics: [
      TRANSFER_TOPIC,
      `0x${addressWord(change.from ?? ACCOUNT)}`,
      `0x${addressWord(change.to ?? DEPOSIT)}`,
    ],
    transactionHash: HASH,
    transactionIndex: 0,
  } as unknown as TransactionReceipt['logs'][number]
}

function receipt(change: Json = {}): Json {
  return { status: 'success', from: ACCOUNT, to: DEPOSIT, logs: [], ...change }
}

const swap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'swap',
  amount: '25',
  tokenIn: 'USDC',
  tokenOut: 'AVAX',
  ...over,
})

const avaxSwap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest =>
  swap({ tokenIn: 'AVAX', tokenOut: 'USDC', amount: '1.5', ...over })

const venueAvalanche = oneClickOriginVenue('avalanche')
const venueMonad = oneClickOriginVenue('monad')

function submitTo(
  prepared: PreparedAction,
  venue = venueAvalanche,
  change: { hash?: string; account?: string; context?: Record<string, string> } = {}
): Promise<SubmitResult> {
  return (venue.submit as NonNullable<typeof venue.submit>)({
    account: change.account ?? ACCOUNT,
    venueId: venue.id,
    signed: { family: 'evm', hash: change.hash ?? HASH },
    context: change.context ?? (prepared.context as Record<string, string>),
  })
}

function withoutPending(result: SubmitResult): void {
  expect(result).toMatchObject({ ok: false })
  expect(result).not.toHaveProperty('pending')
}

function isPending(result: SubmitResult): void {
  expect(result).toMatchObject({ ok: false, pending: true })
}

beforeEach(() => {
  clearTokenCache()
  sim = {
    tokens: tokenList(),
    quotes: [],
    notified: [],
    statuses: ['SUCCESS'],
    statusRecipient: ACCOUNT,
    depositAddress: DEPOSIT,
  }
  rpc.tokenBalance = async () => BigInt(10) ** BigInt(30)
  rpc.nativeBalance = async () => BigInt(10) ** BigInt(30)
  rpc.waitForReceipt = async () => {
    throw new Error('no receipt was arranged for this test')
  }
  rpc.transaction = async () => {
    throw new Error('no transaction was arranged for this test')
  }
  rpc.reads = []
  installFetch()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  wallet.account = { status: 'connected', chainId: 143 }
  wallet.calls = []
})

describe('the chain modules', () => {
  it('confirms what viem says the chain ids are', () => {
    expect(monad.id).toBe(143)
    expect(avalanche.id).toBe(43114)
    expect(EVM_CHAINS.monad.chain.id).toBe(143)
    expect(EVM_CHAINS.avalanche.chain.id).toBe(43114)
  })

  it('finds a module for both, each with its own venue only', () => {
    const avalancheModule = chainModule('avalanche')
    const monadModule = chainModule('monad')
    expect(avalancheModule?.chain).toBe('avalanche')
    expect(monadModule?.chain).toBe('monad')
    expect(avalancheModule?.venues.map((v) => v.id)).toEqual(['1click-avalanche'])
    expect(monadModule?.venues.map((v) => v.id)).toEqual(['1click-monad'])
    expect(avalancheModule?.defaultVenue.swap).toBe('1click-avalanche')
    expect(monadModule?.defaultVenue.swap).toBe('1click-monad')
    expect(chainModule('arc')).toBeUndefined()
  })

  it('lists the tokens the brief names, with the contracts 1Click lists', () => {
    expect(AVALANCHE_TOKENS.map((t) => t.symbol)).toEqual(['AVAX', 'USDC', 'USDT'])
    expect(MONAD_TOKENS.map((t) => t.symbol)).toEqual(['MON', 'USDC', 'USDT0'])
    expect(AVAX_USDC.id.toLowerCase().startsWith('0xb97ef9ef8734')).toBe(true)
    expect(MONAD_USDC.id.toLowerCase().startsWith('0x754704bc059f')).toBe(true)
    expect(AVAX.id).toBe(EVM_NATIVE_ID)
    expect(MON.id).toBe(EVM_NATIVE_ID)
    expect(AVAX.decimals).toBe(18)
    expect(MONAD_USDC.decimals).toBe(6)
  })

  it('offers no venue without the secret that protects what would be issued', () => {
    expect(buildEvmVenues('avalanche', {})).toEqual([])
    expect(buildEvmVenues('monad', { AUTH_SECRET: 'short' })).toEqual([])
    expect(buildEvmVenues('monad', { AUTH_SECRET: 'x'.repeat(32) }).map((v) => v.id)).toEqual([
      '1click-monad',
    ])
  })

  it('tells someone typing USDT on Monad to use USDT0, and finds USDT0 as written', () => {
    const monadModule = chainModule('monad')
    if (monadModule === undefined) throw new Error('no module')
    expect(tokenBySymbol(monadModule.tokens, 'usdt0')).toBe(USDT0)
    expect(tokenBySymbol(monadModule.tokens, 'USDT')).toBeUndefined()
    const refusalOf = (request: ChainActionRequest): string => {
      try {
        assertKnownTokens(monadModule, request)
      } catch (e) {
        return (e as Error).message
      }
      throw new Error('nothing was refused')
    }
    expect(refusalOf(swap({ tokenIn: 'USDT', tokenOut: 'MON' }))).toMatch(/USDT0/)
    expect(refusalOf(swap({ tokenIn: 'USDC', tokenOut: 'usdt' }))).toMatch(/USDT0/)
    expect(() => assertKnownTokens(monadModule, swap({ tokenOut: 'MON' }))).not.toThrow()
  })

  it('prices a token from 1Click by its asset id', async () => {
    await expect(chainModule('avalanche')?.priceUsd(AVAX)).resolves.toBe(20)
    await expect(chainModule('monad')?.priceUsd(MON)).resolves.toBe(0.04)
    await expect(chainModule('monad')?.priceUsd(USDT0)).resolves.toBe(1)
  })

  it('has no price, not an error, when 1Click cannot be read or does not list the token', async () => {
    sim.tokens = sim.tokens.filter((t) => t['symbol'] !== 'MON')
    await expect(chainModule('monad')?.priceUsd(MON)).resolves.toBeUndefined()
    clearTokenCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      })
    )
    await expect(chainModule('monad')?.priceUsd(MON)).resolves.toBeUndefined()
  })
})

describe('asset ids on these chains', () => {
  it('matches a contract in any casing, and the native coin as the entry with no contract', async () => {
    await expect(oneClickAssetId('avalanche', AVAX_USDC)).resolves.toBe('nep245:avax-usdc')
    await expect(oneClickAssetId('avalanche', AVAX)).resolves.toBe('nep245:avax-native')
    await expect(oneClickAssetId('monad', MON)).resolves.toBe('nep245:monad-native')
    await expect(oneClickAssetId('monad', USDT0)).resolves.toBe('nep245:monad-usdt0')
  })

  it('finds no route when 1Click lists another contract under the same symbol', async () => {
    sim.tokens = sim.tokens.filter((t) => t['assetId'] !== 'nep245:avax-usdc')
    await expect(oneClickAssetId('avalanche', AVAX_USDC)).resolves.toBeUndefined()
    await expect(venueAvalanche.quote?.(swap(), ACCOUNT)).rejects.toBeInstanceOf(ChainActionRefused)
    expect(sim.quotes).toEqual([])
  })

  it('finds no route when the decimals disagree', async () => {
    sim.tokens = sim.tokens.map((t) =>
      t['assetId'] === 'nep245:monad-usdc' ? { ...t, decimals: 18 } : t
    )
    await expect(oneClickAssetId('monad', MONAD_USDC)).resolves.toBeUndefined()
  })

  it('does not take another chain’s entry for a contract', async () => {
    sim.tokens = sim.tokens.map((t) =>
      t['assetId'] === 'nep245:monad-usdc' ? { ...t, blockchain: 'avax' } : t
    )
    await expect(oneClickAssetId('monad', MONAD_USDC)).resolves.toBeUndefined()
  })
})

describe('the race on these chains', () => {
  it('reaches the race from what a person types', () => {
    expect(chainCapabilities('avalanche')).toBeDefined()
    expect(chainCapabilities('monad')).toBeDefined()
    expect(chainCapabilities('arc')).toBeUndefined()
    expect(parseChainAction('swap 10 USDC to USDT0')).toMatchObject({
      kind: 'swap',
      tokenIn: 'USDC',
      tokenOut: 'USDT0',
    })
    expect(capabilitySheet('avalanche')).toContain('Agents compete')
    expect(capabilitySheet('monad')).toContain('Agents compete')
    expect(capabilitySheet('monad')).not.toMatch(/Supply:|Stake:|Send:|limit order/)
    expect(capabilitySheet('arc')).not.toContain('Agents compete')
  })

  it('quotes one dry route, with no deposit address, spending the native coin too', async () => {
    const monadModule = chainModule('monad')
    if (monadModule === undefined) throw new Error('no module')
    const routes = await quoteChainRoutes(
      monadModule,
      swap({ tokenIn: 'MON', tokenOut: 'USDC', amount: '100' }),
      ACCOUNT
    )
    expect(routes.map((r) => r.id)).toEqual(['1click-monad-1'])
    expect(sim.quotes.map((q) => q['dry'])).toEqual([true])
    expect(JSON.stringify(routes)).not.toContain(DEPOSIT)
    expect(routes[0]?.receiveAmount).toBe('4')
    expect(singleRouteNote(routes.length, 'Monad')).toBe(
      "One route available on Monad. The agents are judging whether it's worth taking."
    )
  })

  it('gives neither chain Stellar prices, Stellar assets or the other chain’s venues', () => {
    for (const chain of ['avalanche', 'monad']) {
      const market = buildMarketContext(chain, {}, 'mainnet')
      expect(market.prices).toEqual({})
      expect(market.assets ?? []).toEqual([])
      const ids = market.venues.map((v) => v.id)
      expect(ids).not.toContain(chain === 'avalanche' ? '1click-monad' : '1click-avalanche')
      expect(ids).not.toContain('uniswap')
    }
  })

  it('leaves Arc’s market as it was', () => {
    const market = buildMarketContext('arc', {}, 'testnet')
    expect(Object.keys(market.prices).length).toBeGreaterThan(0)
  })
})

describe('naming the chain you are on', () => {
  const moduleFor = (slug: 'avalanche' | 'monad'): ChainModule => {
    const found = chainModule(slug)
    if (found === undefined) throw new Error('no module')
    return found
  }
  const toNative = { avalanche: 'AVAX', monad: 'MON' } as const

  /** A chain with two venues, so a default and a named venue can be told apart. */
  function twoVenues(chain: 'solana' | 'sui' | 'near'): ChainModule {
    const venue = (id: string, name: string): ChainVenue => ({
      id,
      name,
      kinds: ['swap'],
      quote: async () => ({ receive: { amount: '1', symbol: 'B' } }),
      prepare: async () => ({ venueId: id }) as PreparedAction,
      assertSafe: () => undefined,
    })
    return {
      chain,
      tokens: [
        { symbol: 'A', id: 'a', decimals: 6 },
        { symbol: 'B', id: 'b', decimals: 6 },
      ],
      venues: [venue('alpha', 'Alpha Swap'), venue('beta', 'Beta Swap')],
      defaultVenue: { swap: 'beta' },
      priceUsd: async () => 1,
      submit: async () => ({ ok: false, error: 'unused here' }),
    }
  }
  const ab = (venue: string): ChainActionRequest => ({
    kind: 'swap',
    amount: '1',
    tokenIn: 'A',
    tokenOut: 'B',
    venue,
  })

  it('reads as it was typed', () => {
    expect(parseChainAction('swap 10 USDC to MON on monad')).toMatchObject({ venue: 'monad' })
  })

  it.each<['avalanche' | 'monad', string]>([
    ['avalanche', 'avalanche'],
    ['avalanche', 'Avalanche'],
    ['avalanche', ' AVALANCHE '],
    ['monad', 'monad'],
    ['monad', 'Monad'],
  ])('races on %s when told "on %s"', async (slug, venue) => {
    const request = swap({ tokenOut: toNative[slug], venue })
    const routes = await quoteChainRoutes(moduleFor(slug), request, ACCOUNT)
    expect(routes.map((r) => r.id)).toEqual([`1click-${slug}-1`])
  })

  it.each<['avalanche' | 'monad', string]>([
    ['avalanche', 'avalanche'],
    ['monad', 'Monad'],
  ])('builds on %s when told "on %s"', async (slug, venue) => {
    const request = swap({ tokenOut: toNative[slug], venue })
    const prepared = await prepareChainAction(moduleFor(slug), request, ACCOUNT, {})
    expect(prepared.venueId).toBe(`1click-${slug}`)
  })

  it.each(['solana', 'Solana', 'sui', 'near', 'NEAR', 'stellar', 'avalanche', 'arc'])(
    'does not quietly run on Monad when told "on %s"',
    async (venue) => {
      const request = swap({ tokenOut: 'MON', venue })
      await expect(quoteChainRoutes(moduleFor('monad'), request, ACCOUNT)).resolves.toEqual([])
      await expect(prepareChainAction(moduleFor('monad'), request, ACCOUNT, {})).rejects.toThrow(
        /can't swap here/
      )
      expect(sim.quotes.filter((q) => q['dry'] === false)).toEqual([])
    }
  )

  it.each(['1click', 'NEAR Intents', '1click-monad'])(
    'still takes a real venue name on Monad: %s',
    async (venue) => {
      const request = swap({ tokenOut: 'MON', venue })
      const routes = await quoteChainRoutes(moduleFor('monad'), request, ACCOUNT)
      expect(routes.map((r) => r.id)).toEqual(['1click-monad-1'])
      const prepared = await prepareChainAction(moduleFor('monad'), request, ACCOUNT, {})
      expect(prepared.venueId).toBe('1click-monad')
    }
  )

  it('refuses a venue that isn’t here', async () => {
    const request = swap({ tokenOut: 'MON', venue: 'jupiter' })
    await expect(quoteChainRoutes(moduleFor('monad'), request, ACCOUNT)).resolves.toEqual([])
    await expect(prepareChainAction(moduleFor('monad'), request, ACCOUNT, {})).rejects.toThrow(
      /"jupiter" can't swap here/
    )
  })

  it.each<['solana' | 'sui' | 'near', string]>([
    ['solana', 'solana'],
    ['sui', 'Sui'],
    ['near', 'NEAR'],
  ])('counts as no venue named on %s too: "%s"', async (chain, venue) => {
    const api = twoVenues(chain)
    const routes = await quoteChainRoutes(api, ab(venue), ACCOUNT)
    expect(routes.map((r) => r.id)).toEqual(['alpha-1', 'beta-1'])
    await expect(prepareChainAction(api, ab(venue), ACCOUNT, {})).resolves.toMatchObject({
      venueId: 'beta',
    })
  })

  it('still filters by a real venue, and refuses another chain, on those chains', async () => {
    const api = twoVenues('solana')
    const routes = await quoteChainRoutes(api, ab('alpha'), ACCOUNT)
    expect(routes.map((r) => r.id)).toEqual(['alpha-1'])
    await expect(prepareChainAction(api, ab('alpha'), ACCOUNT, {})).resolves.toMatchObject({
      venueId: 'alpha',
    })
    await expect(quoteChainRoutes(api, ab('monad'), ACCOUNT)).resolves.toEqual([])
    await expect(prepareChainAction(api, ab('monad'), ACCOUNT, {})).rejects.toThrow(
      /"monad" can't swap here/
    )
  })
})

describe('the Apps page rows', () => {
  const on = (slug: 'avalanche' | 'monad' | 'arc' | 'stellar'): string[] =>
    venues.filter((v) => venueOnChain(v, CHAIN_DESCRIPTORS[slug])).map((v) => v.id)

  it('shows each chain its own row and no venue that does not name it', () => {
    expect(on('avalanche')).toEqual(['1click-avalanche'])
    expect(on('monad')).toEqual(['1click-monad'])
  })

  it('changes nothing for another family or for Arc', () => {
    expect(on('stellar')).toEqual(venues.filter((v) => v.family === 'stellar').map((v) => v.id))
    const arc = on('arc')
    expect(arc).toContain('uniswap')
    expect(arc).not.toContain('1click-avalanche')
    expect(arc).not.toContain('1click-monad')
    const marketOnArc = buildMarketContext('arc', {}, 'testnet').venues.map((v) => v.id)
    expect(marketOnArc).toEqual(arc)
  })

  it('claims no execution, because the rows are client-safe and can’t read the secret', () => {
    for (const id of ['1click-avalanche', '1click-monad']) {
      const row = venues.find((v) => v.id === id)
      expect(row?.family).toBe('evm')
      expect(row?.integration).toBeUndefined()
    }
  })
})

describe('assertSafe: what may be signed', () => {
  const client = (): never => {
    throw new Error('assertSafe must not read the chain')
  }
  const avalancheDeposit = createEvmDeposit('avalanche', client)
  const monadDeposit = createEvmDeposit('monad', client)

  const nativeOrder = {
    account: ACCOUNT,
    depositAddress: DEPOSIT,
    memo: undefined,
    amount: '1.5',
    token: AVAX,
  }
  const usdcOrder = { ...nativeOrder, amount: '25', token: AVAX_USDC }

  const transfer = (to: string, units: bigint): string =>
    encodeFunctionData({
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [to as Address, units],
    })

  const nativePayload = (change: Json = {}): SigningPayload =>
    ({
      family: 'evm',
      chainId: 43114,
      to: DEPOSIT,
      data: '0x',
      value: ONE_AND_A_HALF_AVAX,
      ...change,
    }) as SigningPayload

  const tokenPayload = (change: Json = {}): SigningPayload =>
    ({
      family: 'evm',
      chainId: 43114,
      to: AVAX_USDC.id,
      data: transfer(DEPOSIT, USD_UNITS),
      value: '0',
      ...change,
    }) as SigningPayload

  it('admits a native transfer only with the exact value and empty data', () => {
    expect(() => avalancheDeposit.assertSafe(nativePayload(), nativeOrder)).not.toThrow()
  })

  it.each<[string, Json]>([
    ['a value one unit more', { value: '1500000000000000001' }],
    ['a value one unit less', { value: '1499999999999999999' }],
    ['no value', { value: '0' }],
    ['a value in hex', { value: '0x14d1120d7b160000' }],
    ['a padded value', { value: `0${ONE_AND_A_HALF_AVAX}` }],
    ['data on the transfer', { data: '0xdeadbeef' }],
    ['a transfer call as data', { data: transfer(DEPOSIT, USD_UNITS) }],
    ['no data field at all', { data: '' }],
    ['another recipient', { to: OTHER }],
    ['the token contract as recipient', { to: AVAX_USDC.id }],
    ['Monad’s chain id', { chainId: 143 }],
  ])('refuses a native transfer with %s', (_name, change) => {
    expect(() => avalancheDeposit.assertSafe(nativePayload(change), nativeOrder)).toThrow(
      ChainActionRefused
    )
  })

  it('admits an ERC-20 transfer only with no value and exactly one transfer call', () => {
    expect(() => avalancheDeposit.assertSafe(tokenPayload(), usdcOrder)).not.toThrow()
    expect(() =>
      avalancheDeposit.assertSafe(tokenPayload({ to: AVAX_USDC.id.toLowerCase() }), usdcOrder)
    ).not.toThrow()
  })

  it.each<[string, Json]>([
    ['value attached', { value: '1' }],
    ['the deposit as the call target', { to: DEPOSIT }],
    ['USDT in place of USDC', { to: AVAX_USDT.id }],
    ['another recipient', { data: transfer(OTHER, USD_UNITS) }],
    ['a different amount', { data: transfer(DEPOSIT, USD_UNITS + BigInt(1)) }],
    ['bytes after the transfer', { data: `${transfer(DEPOSIT, USD_UNITS)}00` }],
    [
      'dirty padding before the address',
      { data: `0xa9059cbb${'f'.repeat(24)}${'2'.repeat(40)}${word('17d7840')}` },
    ],
    ['an approve', { data: `0x095ea7b3${addressWord(DEPOSIT)}${word('17d7840')}` }],
    ['no calldata', { data: '0x' }],
    ['Monad’s chain id', { chainId: 143 }],
  ])('refuses an ERC-20 transfer with %s', (_name, change) => {
    expect(() => avalancheDeposit.assertSafe(tokenPayload(change), usdcOrder)).toThrow(
      ChainActionRefused
    )
  })

  it('requires 143 on Monad and refuses 43114 there', () => {
    const order = { ...nativeOrder, amount: '100', token: MON }
    const units = '100000000000000000000'
    const payload = (chainId: number): SigningPayload => ({
      family: 'evm',
      chainId,
      to: DEPOSIT,
      data: '0x',
      value: units,
    })
    expect(() => monadDeposit.assertSafe(payload(143), order)).not.toThrow()
    expect(() => monadDeposit.assertSafe(payload(43114), order)).toThrow(/Monad/)
  })

  it('never assumes USDC: a USDT order is a USDT transfer, and no token at all is refused', () => {
    const usdtOrder = { ...usdcOrder, token: AVAX_USDT }
    expect(() =>
      avalancheDeposit.assertSafe(tokenPayload({ to: AVAX_USDT.id }), usdtOrder)
    ).not.toThrow()
    expect(() => avalancheDeposit.assertSafe(tokenPayload(), usdtOrder)).toThrow(ChainActionRefused)
    const { token: _absent, ...noToken } = usdcOrder
    expect(() => avalancheDeposit.assertSafe(tokenPayload(), noToken)).toThrow(ChainActionRefused)
  })

  it('refuses a token from another chain’s list', () => {
    expect(() =>
      avalancheDeposit.assertSafe(tokenPayload({ to: MONAD_USDC.id }), {
        ...usdcOrder,
        token: MONAD_USDC,
      })
    ).toThrow(ChainActionRefused)
  })

  it('refuses another family, and a memo', () => {
    expect(() =>
      avalancheDeposit.assertSafe({ family: 'solana', transaction: 'AAAA' }, nativeOrder)
    ).toThrow(ChainActionRefused)
    expect(() =>
      avalancheDeposit.assertSafe(nativePayload(), { ...nativeOrder, memo: '42' })
    ).toThrow(/memo/i)
  })

  it('takes no token contract and no zero address as a deposit address', () => {
    expect(avalancheDeposit.isDepositAddress(DEPOSIT)).toBe(true)
    expect(avalancheDeposit.isDepositAddress(AVAX_USDC.id.toLowerCase())).toBe(false)
    expect(avalancheDeposit.isDepositAddress(AVAX_USDT.id)).toBe(false)
    expect(monadDeposit.isDepositAddress(USDT0.id)).toBe(false)
    expect(monadDeposit.isDepositAddress(ZERO)).toBe(false)
    expect(monadDeposit.isAccount(ZERO)).toBe(false)
    expect(monadDeposit.isAccount('not an address')).toBe(false)
  })
})

describe('prepare', () => {
  it('builds a native transfer of exactly the quoted amount, after a dry and a real quote', async () => {
    const prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
    expect(sim.quotes.map((q) => q['dry'])).toEqual([true, false])
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId: 43114,
      to: DEPOSIT,
      data: '0x',
      value: ONE_AND_A_HALF_AVAX,
    })
    expect(prepared.pay).toEqual({ amount: '1.5', symbol: 'AVAX' })
    expect(prepared.context?.['amount']).toBe(ONE_AND_A_HALF_AVAX)
    expect(prepared.context?.['token']).toBe(EVM_NATIVE_ID)
    expect(prepared.summary).toContain('Avalanche')
    expect(sim.quotes[0]?.['originAsset']).toBe('nep245:avax-native')
  })

  it('builds a transfer of the token asked for, not USDC', async () => {
    const prepared = await venueAvalanche.prepare(swap({ tokenIn: 'USDT' }), ACCOUNT)
    const expected: SigningPayload = {
      family: 'evm',
      chainId: 43114,
      to: AVAX_USDT.id,
      data: encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: 'transfer',
        args: [DEPOSIT, USD_UNITS],
      }),
      value: '0',
    }
    expect(prepared.signing).toEqual(expected)
    expect(prepared.context?.['token']).toBe(AVAX_USDT.id)
    expect(() =>
      venueAvalanche.assertSafe(prepared.signing, ACCOUNT, prepared.context)
    ).not.toThrow()
  })

  it('builds on Monad for chain 143, through the whole prepare path', async () => {
    const monadModule = chainModule('monad')
    if (monadModule === undefined) throw new Error('no module')
    const prepared = await prepareChainAction(
      monadModule,
      swap({ tokenIn: 'MON', tokenOut: 'USDT0', amount: '100' }),
      ACCOUNT,
      {}
    )
    expect(prepared.venueId).toBe('1click-monad')
    expect(prepared.signing).toMatchObject({
      family: 'evm',
      chainId: 143,
      to: DEPOSIT,
      value: '100000000000000000000',
    })
    expect(prepared.summary).toContain('Monad')
  })

  it('refuses a deposit address that is the token contract, or not an address', async () => {
    for (const bad of [AVAX_USDC.id, 'not-an-address', ZERO]) {
      sim.depositAddress = bad
      await expect(venueAvalanche.prepare(swap(), ACCOUNT)).rejects.toThrow(/deposit address/i)
    }
  })

  it('refuses an account that is not an EVM address, in words that read properly', async () => {
    await expect(venueAvalanche.prepare(swap(), 'alice.near')).rejects.toThrow(
      'That is not an Avalanche wallet address.'
    )
    await expect(venueMonad.prepare(swap({ tokenOut: 'MON' }), 'alice.near')).rejects.toThrow(
      'That is not a Monad wallet address.'
    )
  })

  describe('reading what the wallet holds', () => {
    const reserve = (chain: 'avalanche' | 'monad'): bigint => BigInt(EVM_CHAINS[chain].gasReserve)

    function expectNoAddressAsked(): void {
      expect(sim.quotes.filter((q) => q['dry'] === false)).toEqual([])
    }

    it('reads the token from its own contract, for this account', async () => {
      const seen: string[][] = []
      rpc.tokenBalance = async (tokenId, account) => {
        seen.push([tokenId, account])
        return USD_UNITS
      }
      await venueAvalanche.prepare(swap({ tokenIn: 'USDT' }), ACCOUNT)
      expect(seen).toEqual([[AVAX_USDT.id, ACCOUNT]])
    })

    it('refuses less of the token than the swap needs, before any deposit address', async () => {
      rpc.tokenBalance = async () => USD_UNITS - BigInt(1)
      await expect(venueAvalanche.prepare(swap(), ACCOUNT)).rejects.toThrow(
        /less USDC.*Nothing was signed or sent\.$/
      )
      expectNoAddressAsked()
    })

    it('takes exactly enough of the token', async () => {
      rpc.tokenBalance = async () => USD_UNITS
      await expect(venueAvalanche.prepare(swap(), ACCOUNT)).resolves.toBeDefined()
    })

    it('refuses a token swap with too little of the coin that pays for gas', async () => {
      rpc.nativeBalance = async () => reserve('monad') - BigInt(1)
      await expect(venueMonad.prepare(swap({ tokenOut: 'MON' }), ACCOUNT)).rejects.toThrow(
        /MON.*network fee.*Nothing was signed or sent\.$/
      )
      expectNoAddressAsked()
    })

    it('keeps gas back when the native coin is what is being spent', async () => {
      const amount = BigInt(ONE_AND_A_HALF_AVAX)
      rpc.nativeBalance = async () => amount
      await expect(venueAvalanche.prepare(avaxSwap(), ACCOUNT)).rejects.toThrow(
        /network fee.*Nothing was signed or sent\.$/
      )
      expectNoAddressAsked()
      rpc.nativeBalance = async () => amount + reserve('avalanche') - BigInt(1)
      await expect(venueAvalanche.prepare(avaxSwap(), ACCOUNT)).rejects.toBeInstanceOf(
        ChainActionRefused
      )
      expectNoAddressAsked()
      rpc.nativeBalance = async () => amount + reserve('avalanche')
      await expect(venueAvalanche.prepare(avaxSwap(), ACCOUNT)).resolves.toBeDefined()
    })

    it.each<[string, () => void]>([
      [
        'the token',
        () => {
          rpc.tokenBalance = async () => {
            throw new Error('rpc down')
          }
        },
      ],
      [
        'the gas coin',
        () => {
          rpc.nativeBalance = async () => {
            throw new Error('rpc down')
          }
        },
      ],
    ])('fails closed when %s cannot be read', async (_name, arrange) => {
      arrange()
      await expect(venueAvalanche.prepare(swap(), ACCOUNT)).rejects.toThrow(
        /Could not read.*Avalanche.*Nothing was signed or sent\.$/
      )
      expectNoAddressAsked()
    })

    describe('Monad’s 10 MON reserve', () => {
      const TEN_MON = BigInt(10) * BigInt(10) ** BigInt(18)
      const HUNDRED_MON = BigInt(100) * BigInt(10) ** BigInt(18)
      const monSwap = swap({ tokenIn: 'MON', tokenOut: 'USDC', amount: '100' })
      const hasNote = (prepared: PreparedAction): boolean =>
        prepared.notes.some((note) => /10 MON reserve/.test(note))

      it('says so on the card, and still builds, when a spend leaves under 10 MON', async () => {
        rpc.nativeBalance = async () => HUNDRED_MON + TEN_MON - BigInt(1)
        const prepared = await venueMonad.prepare(monSwap, ACCOUNT)
        expect(hasNote(prepared)).toBe(true)
        expect(prepared.notes.join(' ')).toMatch(/gas/)
        expect(prepared.signing).toMatchObject({ family: 'evm', chainId: 143 })
      })

      it('says nothing when a spend leaves exactly 10 MON, or more', async () => {
        rpc.nativeBalance = async () => HUNDRED_MON + TEN_MON
        expect(hasNote(await venueMonad.prepare(monSwap, ACCOUNT))).toBe(false)
        rpc.nativeBalance = async () => HUNDRED_MON * BigInt(2)
        expect(hasNote(await venueMonad.prepare(monSwap, ACCOUNT))).toBe(false)
      })

      it('says nothing for a token, which leaves the coin alone', async () => {
        rpc.nativeBalance = async () => BigInt(EVM_CHAINS.monad.gasReserve)
        expect(hasNote(await venueMonad.prepare(swap({ tokenOut: 'MON' }), ACCOUNT))).toBe(false)
      })

      it('says nothing on Avalanche, which has no such rule', async () => {
        rpc.nativeBalance = async () =>
          BigInt(ONE_AND_A_HALF_AVAX) + BigInt(EVM_CHAINS.avalanche.gasReserve)
        const prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
        expect(prepared.notes.join(' ')).not.toMatch(/reserve/i)
      })
    })

    it('does not read balances for a race quote', async () => {
      rpc.tokenBalance = async () => {
        throw new Error('a quote must not read this')
      }
      await expect(venueAvalanche.quote?.(swap(), ACCOUNT)).resolves.toBeDefined()
    })
  })

  describe('the signed context', () => {
    it.each<[string, Record<string, string>]>([
      ['another deposit address', { depositAddress: OTHER }],
      ['another amount', { amount: '1' }],
      ['another token', { token: AVAX_USDC.id }],
      ['a later deadline', { deadline: '2099-01-01T00:00:00.000Z' }],
      ['another proof', { proof: 'forged' }],
    ])('refuses %s', async (_name, change) => {
      const prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
      expect(() =>
        venueAvalanche.assertSafe(prepared.signing, ACCOUNT, { ...prepared.context, ...change })
      ).toThrow(ChainActionRefused)
    })

    it('does not pass for another account or on the other chain', async () => {
      const prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
      expect(() => venueAvalanche.assertSafe(prepared.signing, OTHER, prepared.context)).toThrow(
        ChainActionRefused
      )
      expect(() =>
        venueMonad.assertSafe({ ...prepared.signing, chainId: 143 } as SigningPayload, ACCOUNT, {
          ...(prepared.context as Record<string, string>),
        })
      ).toThrow(ChainActionRefused)
    })

    it('does not let the browser spend USDC under a proof that named USDT', async () => {
      const prepared = await venueAvalanche.prepare(swap({ tokenIn: 'USDT' }), ACCOUNT)
      expect(() =>
        venueAvalanche.assertSafe(
          { ...prepared.signing, to: AVAX_USDC.id } as SigningPayload,
          ACCOUNT,
          prepared.context
        )
      ).toThrow(ChainActionRefused)
    })
  })
})

describe('submit: what the chain says the wallet sent', () => {
  describe('a native transfer', () => {
    let prepared: PreparedAction

    beforeEach(async () => {
      prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
      rpc.transaction = async () => ({ value: BigInt(ONE_AND_A_HALF_AVAX), input: '0x' })
    })

    it('accepts the transfer, tells 1Click, and is done when 1Click says so', async () => {
      rpc.waitForReceipt = async () => receipt()
      await expect(submitTo(prepared)).resolves.toEqual({
        ok: true,
        hash: HASH,
        explorerUrl: `https://snowtrace.io/tx/${HASH}`,
      })
      expect(sim.notified).toEqual([{ txHash: HASH, depositAddress: DEPOSIT }])
    })

    it.each<[string, Json]>([
      ['from another account', { from: OTHER }],
      ['to another address', { to: OTHER }],
      ['to no address', { to: null }],
    ])('does not take a receipt %s as this order’s transfer', async (_name, change) => {
      rpc.waitForReceipt = async () => receipt(change)
      const result = await submitTo(prepared)
      isPending(result)
      expect(result).toMatchObject({ error: expect.stringMatching(/not this swap/) })
      expect(sim.notified).toEqual([])
    })

    it('reads the value, since a receipt has none, and refuses any other value', async () => {
      rpc.waitForReceipt = async () => receipt()
      rpc.transaction = async () => ({
        value: BigInt(ONE_AND_A_HALF_AVAX) - BigInt(1),
        input: '0x',
      })
      const result = await submitTo(prepared)
      isPending(result)
      expect(sim.notified).toEqual([])
    })

    it('stays pending when a landed transfer’s value cannot be read', async () => {
      rpc.waitForReceipt = async () => receipt()
      rpc.transaction = async () => {
        throw new Error('rpc down')
      }
      isPending(await submitTo(prepared))
      expect(sim.notified).toEqual([])
    })

    it('calls a revert clean only when it is this account’s, to this deposit address', async () => {
      rpc.waitForReceipt = async () => receipt({ status: 'reverted' })
      const clean = await submitTo(prepared)
      withoutPending(clean)
      expect(clean).toMatchObject({ error: expect.stringMatching(/AVAX did not move/) })
      expect(sim.notified).toEqual([])

      for (const change of [{ from: OTHER }, { to: OTHER }, { to: null }]) {
        rpc.waitForReceipt = async () => receipt({ status: 'reverted', ...change })
        isPending(await submitTo(prepared))
      }
    })

    it('does not call a revert clean when the transaction carried data, or can’t be read', async () => {
      rpc.waitForReceipt = async () => receipt({ status: 'reverted' })
      rpc.transaction = async () => ({ value: BigInt(ONE_AND_A_HALF_AVAX), input: '0xdeadbeef' })
      isPending(await submitTo(prepared))
      rpc.transaction = async () => ({ value: BigInt(1), input: '0x' })
      isPending(await submitTo(prepared))
      rpc.transaction = async () => {
        throw new Error('rpc down')
      }
      isPending(await submitTo(prepared))
    })

    it('names no reserve on Avalanche, which has none', async () => {
      rpc.waitForReceipt = async () => receipt({ status: 'reverted' })
      expect(await submitTo(prepared)).not.toMatchObject({
        error: expect.stringMatching(/reserve/i),
      })
    })
  })

  describe('a native transfer on Monad that reverts', () => {
    it('names the 10 MON reserve as the likely cause', async () => {
      const prepared = await venueMonad.prepare(
        swap({ tokenIn: 'MON', tokenOut: 'USDC', amount: '100' }),
        ACCOUNT
      )
      rpc.waitForReceipt = async () => receipt({ status: 'reverted' })
      rpc.transaction = async () => ({ value: BigInt('100000000000000000000'), input: '0x' })
      const clean = await submitTo(prepared, venueMonad)
      withoutPending(clean)
      expect(clean).toMatchObject({ error: expect.stringMatching(/10 MON reserve/) })
      expect(clean).toMatchObject({ error: expect.stringMatching(/MON did not move/) })
    })

    it('does not blame the reserve for a token transfer that reverts on Monad', async () => {
      const prepared = await venueMonad.prepare(swap({ tokenOut: 'MON' }), ACCOUNT)
      rpc.waitForReceipt = async () => receipt({ status: 'reverted', to: MONAD_USDC.id })
      rpc.transaction = async () => ({
        value: BigInt(0),
        input: encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: 'transfer',
          args: [DEPOSIT, USD_UNITS],
        }),
      })
      const clean = await submitTo(prepared, venueMonad)
      withoutPending(clean)
      expect(clean).not.toMatchObject({ error: expect.stringMatching(/reserve/i) })
    })
  })

  describe('an ERC-20 transfer', () => {
    let prepared: PreparedAction
    const paying = (logs: unknown[], change: Json = {}): Json =>
      receipt({ to: AVAX_USDC.id, logs, ...change })
    const thisTransfer = encodeFunctionData({
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [DEPOSIT, USD_UNITS],
    })

    beforeEach(async () => {
      prepared = await venueAvalanche.prepare(swap(), ACCOUNT)
      rpc.transaction = async () => ({ value: BigInt(0), input: thisTransfer })
    })

    it.each<[string, string]>([
      [
        'a transfer to someone else',
        encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: 'transfer',
          args: [OTHER, USD_UNITS],
        }),
      ],
      [
        'a transfer of another amount',
        encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: 'transfer',
          args: [DEPOSIT, USD_UNITS + BigInt(1)],
        }),
      ],
      ['an approve', `0x095ea7b3${addressWord(DEPOSIT)}${word('17d7840')}`],
      ['this transfer with bytes after it', `${thisTransfer}00`],
      ['nothing', '0x'],
    ])(
      'does not read an earlier failed call on this token, %s, as this transfer failing',
      async (_name, input) => {
        rpc.waitForReceipt = async () => paying([], { status: 'reverted' })
        rpc.transaction = async () => ({ value: BigInt(0), input })
        const result = await submitTo(prepared)
        isPending(result)
        expect(result).not.toMatchObject({ error: expect.stringMatching(/did not move/) })
      }
    )

    it('does not call a revert this transfer when it also carried value', async () => {
      rpc.waitForReceipt = async () => paying([], { status: 'reverted' })
      rpc.transaction = async () => ({ value: BigInt(1), input: thisTransfer })
      isPending(await submitTo(prepared))
    })

    it('stays pending on a revert when the transaction can’t be read', async () => {
      rpc.waitForReceipt = async () => paying([], { status: 'reverted' })
      rpc.transaction = async () => {
        throw new Error('rpc down')
      }
      const result = await submitTo(prepared)
      isPending(result)
      expect(result).not.toMatchObject({ error: expect.stringMatching(/did not move/) })
    })

    it('accepts a Transfer log of exactly this amount, from the account to the deposit', async () => {
      rpc.waitForReceipt = async () => paying([transferLog(AVAX_USDC.id, USD_UNITS)])
      await expect(submitTo(prepared)).resolves.toMatchObject({ ok: true, hash: HASH })
      expect(sim.notified).toHaveLength(1)
    })

    it.each<[string, () => Json]>([
      [
        'from another account',
        () => paying([transferLog(AVAX_USDC.id, USD_UNITS)], { from: OTHER }),
      ],
      ['to another contract', () => paying([transferLog(AVAX_USDC.id, USD_UNITS)], { to: OTHER })],
      ['with no logs', () => paying([])],
      ['with a log from another token', () => paying([transferLog(AVAX_USDT.id, USD_UNITS)])],
      [
        'with a log from another sender',
        () => paying([transferLog(AVAX_USDC.id, USD_UNITS, { from: OTHER })]),
      ],
      [
        'with a log to another recipient',
        () => paying([transferLog(AVAX_USDC.id, USD_UNITS, { to: OTHER })]),
      ],
      [
        'with a log of another amount',
        () => paying([transferLog(AVAX_USDC.id, USD_UNITS + BigInt(1))]),
      ],
    ])('does not take a receipt %s as this order’s transfer', async (_name, build) => {
      rpc.waitForReceipt = async () => build()
      isPending(await submitTo(prepared))
      expect(sim.notified).toEqual([])
    })

    it('calls a revert clean only when it is this account’s, on this token', async () => {
      rpc.waitForReceipt = async () => paying([], { status: 'reverted' })
      const clean = await submitTo(prepared)
      withoutPending(clean)
      expect(clean).toMatchObject({ error: expect.stringMatching(/USDC did not move/) })

      rpc.waitForReceipt = async () => paying([], { status: 'reverted', from: OTHER })
      isPending(await submitTo(prepared))
      rpc.waitForReceipt = async () => paying([], { status: 'reverted', to: DEPOSIT })
      isPending(await submitTo(prepared))
    })

    it('keeps the latch set on a clean revert, because the wallet sent for itself', async () => {
      rpc.waitForReceipt = async () => paying([], { status: 'reverted' })
      const clean = await submitTo(prepared)
      expect(afterSubmitting(clean, 'evm')).toMatchObject({ latched: true })
    })
  })

  describe('what is never called clean', () => {
    let prepared: PreparedAction
    let hasNoClaimOfNothing: (result: SubmitResult) => void

    beforeEach(async () => {
      prepared = await venueAvalanche.prepare(swap(), ACCOUNT)
      hasNoClaimOfNothing = (result) => {
        isPending(result)
        expect(result).not.toMatchObject({ error: expect.stringMatching(/nothing was/i) })
      }
    })

    it('a receipt that does not come, which is what a hash from another chain gives', async () => {
      rpc.waitForReceipt = async () => {
        throw new Error('timed out')
      }
      const result = await submitTo(prepared)
      hasNoClaimOfNothing(result)
      expect(result).toMatchObject({ error: expect.stringContaining(HASH) })
      expect(sim.notified).toEqual([])
    })

    it.each(['0x1234', `0x${'g'.repeat(64)}`, HASH.slice(2), `${HASH}00`, ''])(
      'a wallet answer that is not a hash: %s',
      async (hash) => {
        const result = await submitTo(prepared, venueAvalanche, { hash })
        hasNoClaimOfNothing(result)
        expect(rpc.reads).toEqual([])
      }
    )

    it('a quote that expired once the wallet had already sent: it is still followed', async () => {
      rpc.waitForReceipt = async () =>
        receipt({ to: AVAX_USDC.id, logs: [transferLog(AVAX_USDC.id, USD_UNITS)] })
      const issuedAt = Date.now()
      vi.useFakeTimers({ now: issuedAt + 10 * 60_000, toFake: ['Date'] })
      await expect(submitTo(prepared)).resolves.toMatchObject({ ok: true })
      expect(sim.notified).toHaveLength(1)
    })

    it.each<[string, Record<string, string>]>([
      ['a changed deposit address', { depositAddress: OTHER }],
      ['a changed amount', { amount: '1' }],
      ['a forged proof', { proof: 'forged' }],
    ])('details that were not issued, %s: the wallet may have sent anyway', async (_n, change) => {
      const result = await submitTo(prepared, venueAvalanche, {
        context: { ...(prepared.context as Record<string, string>), ...change },
      })
      hasNoClaimOfNothing(result)
      expect(result).toMatchObject({ error: expect.stringContaining(HASH) })
      expect(rpc.reads).toEqual([])
      expect(sim.notified).toEqual([])
    })

    it('a proof made for the other chain', async () => {
      const result = await submitTo(prepared, venueMonad)
      hasNoClaimOfNothing(result)
      expect(rpc.reads).toEqual([])
    })

    it('a proof made for another account', async () => {
      const result = await submitTo(prepared, venueAvalanche, { account: OTHER })
      hasNoClaimOfNothing(result)
    })

    it('another family handed to this chain', async () => {
      const result = await (venueAvalanche.submit as NonNullable<typeof venueAvalanche.submit>)({
        account: ACCOUNT,
        venueId: venueAvalanche.id,
        signed: { family: 'solana', signedTransaction: 'AAAA' },
        context: prepared.context,
      })
      hasNoClaimOfNothing(result)
    })

    it('a read that throws anything at all', async () => {
      rpc.waitForReceipt = async () => {
        throw new ChainActionRefused('a refusal is no proof once the wallet has sent')
      }
      hasNoClaimOfNothing(await submitTo(prepared))
    })

    it('a refusal thrown while reading what came back', async () => {
      rpc.waitForReceipt = async () => ({
        get from(): string {
          throw new ChainActionRefused('a refusal is no proof once the wallet has sent')
        },
      })
      hasNoClaimOfNothing(await submitTo(prepared))
    })
  })

  describe('after the transfer lands', () => {
    let prepared: PreparedAction

    beforeEach(async () => {
      prepared = await venueMonad.prepare(swap({ tokenOut: 'MON' }), ACCOUNT)
      rpc.waitForReceipt = async () =>
        receipt({ to: MONAD_USDC.id, logs: [transferLog(MONAD_USDC.id, USD_UNITS)] })
    })

    it('links Monad’s explorer', async () => {
      await expect(submitTo(prepared, venueMonad)).resolves.toEqual({
        ok: true,
        hash: HASH,
        explorerUrl: `https://monadvision.com/tx/${HASH}`,
      })
    })

    it.each(['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'])(
      'calls 1Click’s %s pending, and says where funds should return',
      async (status) => {
        sim.statuses = [status]
        const result = await submitTo(prepared, venueMonad)
        isPending(result)
        expect(result).toMatchObject({ error: expect.stringContaining(ACCOUNT) })
      }
    )

    it('answers a running swap as pending inside the route’s 60 seconds', async () => {
      sim.statuses = ['PROCESSING']
      vi.useFakeTimers()
      const started = Date.now()
      let settledAt: number | undefined
      const running = submitTo(prepared, venueMonad).then((r) => {
        settledAt = Date.now()
        return r
      })
      await vi.advanceTimersByTimeAsync(60_000)
      isPending(await running)
      expect((settledAt as number) - started).toBeLessThan(60_000)
    })

    it('does not mistake a recipient in another casing for another swap', async () => {
      const mixed = '0xAbCdEf0123456789aBcDeF0123456789abcdef01'
      const mine = await venueMonad.prepare(swap({ tokenOut: 'MON' }), mixed)
      rpc.waitForReceipt = async () =>
        receipt({
          from: mixed,
          to: MONAD_USDC.id,
          logs: [transferLog(MONAD_USDC.id, USD_UNITS, { from: mixed })],
        })
      sim.statusRecipient = mixed.toLowerCase()
      await expect(submitTo(mine, venueMonad, { account: mixed })).resolves.toMatchObject({
        ok: true,
      })
    })

    it('holds when 1Click’s record names someone else', async () => {
      sim.statusRecipient = OTHER
      const result = await submitTo(prepared, venueMonad)
      isPending(result)
      expect(result).toMatchObject({ error: expect.stringMatching(/different swap/) })
    })
  })

  // At the deposit itself, because the venue would turn a throw into pending and hide it here.
  describe('an answer that makes no sense still gets an answer', () => {
    const usdcOrder = {
      account: ACCOUNT,
      depositAddress: DEPOSIT,
      memo: undefined,
      amount: '25',
      token: AVAX_USDC,
    }
    const avaxOrder = { ...usdcOrder, amount: '1.5', token: AVAX }

    const deposit = (receiptTo: string, status: string, transaction: () => Promise<unknown>) =>
      createEvmDeposit('avalanche', () => ({
        tokenBalance: async () => BigInt(0),
        nativeBalance: async () => BigInt(0),
        waitForReceipt: async () => receipt({ status, to: receiptTo }) as unknown as EvmReceipt,
        transaction: transaction as EvmClient['transaction'],
      }))

    function pendingAndClaimsNothing(result: SubmitResult): void {
      isPending(result)
      expect(result).not.toMatchObject({ error: expect.stringMatching(/did not move/) })
    }

    it.each<[string, () => Promise<unknown>]>([
      ['no input', async () => ({ value: BigInt(0) })],
      ['null', async () => null],
      ['an input that is not text', async () => ({ value: BigInt(0), input: 7 })],
    ])('a token revert whose read resolves to %s is pending', async (_name, read) => {
      const chain = deposit(AVAX_USDC.id, 'reverted', read)
      pendingAndClaimsNothing(await chain.submit({ family: 'evm', hash: HASH }, usdcOrder))
    })

    it.each<[string, () => Promise<unknown>]>([
      ['no input', async () => ({ value: BigInt(ONE_AND_A_HALF_AVAX) })],
      ['null', async () => null],
    ])('a native revert whose read resolves to %s is pending', async (_name, read) => {
      const chain = deposit(DEPOSIT, 'reverted', read)
      pendingAndClaimsNothing(await chain.submit({ family: 'evm', hash: HASH }, avaxOrder))
    })

    it.each(['not a number', '', '0', '1.1234567'])(
      'a malformed amount, %j, is pending on a revert and on a landed transfer',
      async (amount) => {
        for (const status of ['reverted', 'success']) {
          const read = async () => ({ value: BigInt(0), input: '0x' })
          const chain = deposit(AVAX_USDC.id, status, read)
          pendingAndClaimsNothing(
            await chain.submit({ family: 'evm', hash: HASH }, { ...usdcOrder, amount })
          )
        }
      }
    )

    it('a malformed native amount is pending on a revert too', async () => {
      const read = async () => ({ value: BigInt(0), input: '0x' })
      const chain = deposit(DEPOSIT, 'reverted', read)
      pendingAndClaimsNothing(
        await chain.submit({ family: 'evm', hash: HASH }, { ...avaxOrder, amount: 'not a number' })
      )
    })
  })

  describe('through the real client', () => {
    function transport(answers: Record<string, unknown>) {
      return custom({
        request: async ({ method }: { method: string }) => answers[method] ?? null,
      })
    }

    const order = {
      account: ACCOUNT,
      depositAddress: DEPOSIT,
      memo: undefined,
      amount: '100',
      token: MON,
    }

    const rpcReceipt = {
      blockHash: `0x${'b'.repeat(64)}`,
      blockNumber: '0x1',
      contractAddress: null,
      cumulativeGasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      from: ACCOUNT,
      gasUsed: '0x5208',
      logs: [],
      logsBloom: `0x${'0'.repeat(512)}`,
      status: '0x1',
      to: DEPOSIT,
      transactionHash: HASH,
      transactionIndex: '0x0',
      type: '0x2',
    }

    const rpcTransaction = (hexValue: string): Json => ({
      blockHash: `0x${'b'.repeat(64)}`,
      blockNumber: '0x1',
      from: ACCOUNT,
      gas: '0x5208',
      gasPrice: '0x1',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
      hash: HASH,
      input: '0x',
      nonce: '0x0',
      to: DEPOSIT,
      transactionIndex: '0x0',
      value: hexValue,
      type: '0x2',
      accessList: [],
      chainId: '0x8f',
      v: '0x1',
      r: `0x${'1'.repeat(64)}`,
      s: `0x${'2'.repeat(64)}`,
      yParity: '0x1',
    })

    async function deposit(answers: Record<string, unknown>) {
      const { evmClient } = await import('../chains/evm/client')
      return createEvmDeposit('monad', () => evmClient('monad', transport(answers)))
    }

    const ONE_HUNDRED_MON_HEX = `0x${(BigInt(100) * BigInt(10) ** BigInt(18)).toString(16)}`

    it('confirms a real receipt and a real transaction shape', async () => {
      const chain = await deposit({
        eth_blockNumber: '0x2',
        eth_getTransactionReceipt: rpcReceipt,
        eth_getTransactionByHash: rpcTransaction(ONE_HUNDRED_MON_HEX),
      })
      await expect(chain.submit({ family: 'evm', hash: HASH }, order)).resolves.toMatchObject({
        ok: true,
      })
    })

    it('reads the input of a real reverted transaction before calling it clean', async () => {
      const reverted = { ...rpcReceipt, status: '0x0' }
      const clean = await deposit({
        eth_blockNumber: '0x2',
        eth_getTransactionReceipt: reverted,
        eth_getTransactionByHash: rpcTransaction(ONE_HUNDRED_MON_HEX),
      })
      withoutPending(await clean.submit({ family: 'evm', hash: HASH }, order))

      const other = await deposit({
        eth_blockNumber: '0x2',
        eth_getTransactionReceipt: reverted,
        eth_getTransactionByHash: { ...rpcTransaction(ONE_HUNDRED_MON_HEX), input: '0xdeadbeef' },
      })
      isPending(await other.submit({ family: 'evm', hash: HASH }, order))
    })

    it('refuses a real transaction of another value', async () => {
      const chain = await deposit({
        eth_blockNumber: '0x2',
        eth_getTransactionReceipt: rpcReceipt,
        eth_getTransactionByHash: rpcTransaction('0x1'),
      })
      isPending(await chain.submit({ family: 'evm', hash: HASH }, order))
    })

    it('gives up well inside the route’s limit on a hash this chain has not seen', async () => {
      vi.useFakeTimers()
      const chain = await deposit({ eth_blockNumber: '0x2' })
      let settled: SubmitResult | undefined
      const running = chain.submit({ family: 'evm', hash: HASH }, order).then((r) => {
        settled = r
        return r
      })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)
      isPending(await running)
    })

    it('reads the token’s balance from its contract and the coin as the native balance', async () => {
      const seen: { method: string; params: unknown[] }[] = []
      const { evmClient } = await import('../chains/evm/client')
      const client = evmClient(
        'avalanche',
        custom({
          request: async ({ method, params }: { method: string; params: unknown[] }) => {
            seen.push({ method, params })
            return method === 'eth_call' ? `0x${word('bebc20')}` : '0x5'
          },
        })
      )
      await expect(client.tokenBalance(AVAX_USDT.id as Address, ACCOUNT as Address)).resolves.toBe(
        BigInt(12_500_000)
      )
      await expect(client.nativeBalance(ACCOUNT as Address)).resolves.toBe(BigInt(5))
      const call = seen.find((s) => s.method === 'eth_call')?.params[0] as { to: string }
      expect(call.to.toLowerCase()).toBe(AVAX_USDT.id.toLowerCase())
    })
  })

  describe('which network the client talks to', () => {
    function rpcCalls(): string[] {
      const urls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
          urls.push(String(input))
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x5' }))
        })
      )
      return urls
    }

    // The mock hands back the real client only for a transport, so these go through the original.
    async function realClient(chain: 'avalanche' | 'monad') {
      const mocked = (await import('../chains/evm/client')) as unknown as {
        realEvmClient: typeof import('../chains/evm/client').evmClient
      }
      return mocked.realEvmClient(chain)
    }

    it('uses MONAD_RPC_URL when it is set', async () => {
      const urls = rpcCalls()
      vi.stubEnv('MONAD_RPC_URL', ' https://monad.example.test/rpc ')
      const client = await realClient('monad')
      await client.nativeBalance(ACCOUNT as Address)
      expect(urls).toEqual(['https://monad.example.test/rpc'])
    })

    it('falls back to viem’s default for Monad', async () => {
      const urls = rpcCalls()
      vi.stubEnv('MONAD_RPC_URL', '')
      const client = await realClient('monad')
      await client.nativeBalance(ACCOUNT as Address)
      expect(urls.map((url) => new URL(url).origin)).toEqual([
        new URL(monad.rpcUrls.default.http[0]).origin,
      ])
    })

    it('uses AVALANCHE_RPC_URL on Avalanche', async () => {
      const urls = rpcCalls()
      vi.stubEnv('AVALANCHE_RPC_URL', 'https://avax.example.test/rpc')
      const client = await realClient('avalanche')
      await client.nativeBalance(ACCOUNT as Address)
      expect(urls).toEqual(['https://avax.example.test/rpc'])
    })
  })
})

describe('the submit route', () => {
  async function post(chain: string, body: unknown): Promise<Response> {
    const { POST } = await import('../../app/api/chain/[chain]/submit/route')
    return POST(
      new Request(`http://localhost/api/chain/${chain}/submit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ chain }) }
    )
  }

  it.each<[string, typeof venueAvalanche, () => ChainActionRequest]>([
    ['avalanche', venueAvalanche, () => avaxSwap()],
    ['monad', venueMonad, () => swap({ tokenIn: 'MON', tokenOut: 'USDC', amount: '100' })],
  ])('accepts { family: evm, hash } on %s and follows it', async (chain, venue, request) => {
    const prepared = await venue.prepare(request(), ACCOUNT)
    rpc.waitForReceipt = async () => receipt()
    rpc.transaction = async () => ({
      value: BigInt((prepared.signing as Extract<SigningPayload, { family: 'evm' }>).value),
      input: '0x',
    })
    const res = await post(chain, {
      account: ACCOUNT,
      venueId: venue.id,
      signed: { family: 'evm', hash: HASH },
      context: prepared.context,
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('answers a receipt from another account as pending, which holds the latch', async () => {
    const prepared = await venueAvalanche.prepare(avaxSwap(), ACCOUNT)
    rpc.waitForReceipt = async () => receipt({ from: OTHER })
    const res = await post('avalanche', {
      account: ACCOUNT,
      venueId: venueAvalanche.id,
      signed: { family: 'evm', hash: HASH },
      context: prepared.context,
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as SubmitResult
    expect(body).toMatchObject({ ok: false, pending: true })
    expect(afterSubmitting(body, 'evm')).toMatchObject({ phase: 'pending', latched: true })
  })

  it.each<[string, string, unknown]>([
    ['solana bytes on Avalanche', 'avalanche', { family: 'solana', signedTransaction: 'AAAA' }],
    ['a near hash on Monad', 'monad', { family: 'near', hashes: ['abc'] }],
  ])('refuses %s', async (_name, chain, signed) => {
    const res = await post(chain, {
      account: ACCOUNT,
      venueId: `1click-${chain}`,
      signed,
      context: {},
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'wrong_chain' })
  })

  it('refuses an EVM answer on a chain of another family', async () => {
    const res = await post('solana', {
      account: ACCOUNT,
      venueId: '1click-solana',
      signed: { family: 'evm', hash: HASH },
      context: {},
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'wrong_chain' })
  })
})

describe('a stale card, before the wallet opens', () => {
  const NOW = Date.parse('2026-11-04T12:00:00.000Z')
  const card = (
    family: SigningPayload['family'],
    deadline?: string
  ): Pick<PreparedAction, 'signing' | 'context'> => ({
    signing: { family } as SigningPayload,
    ...(deadline !== undefined ? { context: { deadline } } : {}),
  })

  it('is stopped on an EVM chain, where no later check could stop the wallet sending', () => {
    expect(quoteExpiredBeforeSigning(card('evm', '2026-11-04T11:59:59.000Z'), NOW)).toBe(true)
    expect(quoteExpiredBeforeSigning(card('evm', '2026-11-04T12:00:01.000Z'), NOW)).toBe(false)
    expect(quoteExpiredBeforeSigning(card('evm', 'not a date'), NOW)).toBe(true)
    expect(quoteExpiredBeforeSigning(card('evm'), NOW)).toBe(false)
  })

  it('says what to do in words true on both cards, since the direct one has no Review', () => {
    expect(QUOTE_EXPIRED).toMatch(/nothing was sent/)
    expect(QUOTE_EXPIRED).not.toMatch(/Review/)
  })

  it('is left to the server on chains whose bytes it sends, and to NEAR as it was', () => {
    for (const family of ['solana', 'sui', 'near'] as const) {
      expect(quoteExpiredBeforeSigning(card(family, '2020-01-01T00:00:00.000Z'), NOW)).toBe(false)
    }
  })
})

describe('the wallet', () => {
  async function adapters() {
    return import('../adapters/evm-adapter')
  }

  it('sends the native value as a bigint, on Monad', async () => {
    const { monadAdapter } = await adapters()
    const out = await monadAdapter.signPrepared?.({
      family: 'evm',
      chainId: 143,
      to: DEPOSIT,
      data: '0x',
      value: '100000000000000000000',
    })
    expect(out).toEqual({ ok: true, signed: { family: 'evm', hash: WALLET_HASH } })
    expect(wallet.calls).toEqual([
      ['send', { to: DEPOSIT, data: '0x', value: BigInt('100000000000000000000'), chainId: 143 }],
    ])
  }, 30_000)

  it('switches to Monad first when the wallet is elsewhere', async () => {
    wallet.account = { status: 'connected', chainId: 43114 }
    const { monadAdapter } = await adapters()
    await monadAdapter.signPrepared?.({
      family: 'evm',
      chainId: 143,
      to: DEPOSIT,
      data: '0x',
      value: '1',
    })
    expect(wallet.calls.map((c) => c[0])).toEqual(['switch', 'send'])
    expect(wallet.calls[0]?.[1]).toEqual({ chainId: 143 })
  })

  it('sends a native value on Avalanche too', async () => {
    wallet.account = { status: 'connected', chainId: 43114 }
    const { avalancheAdapter } = await adapters()
    await avalancheAdapter.signPrepared?.({
      family: 'evm',
      chainId: 43114,
      to: DEPOSIT,
      data: '0x',
      value: ONE_AND_A_HALF_AVAX,
    })
    expect(wallet.calls[0]?.[1]).toMatchObject({ value: BigInt(ONE_AND_A_HALF_AVAX) })
  })

  it.each<[string, SigningPayload]>([
    [
      'Avalanche’s chain id',
      { family: 'evm', chainId: 43114, to: DEPOSIT, data: '0x', value: '1' },
    ],
    [
      'a value that is not decimal',
      { family: 'evm', chainId: 143, to: DEPOSIT, data: '0x', value: '0x10' },
    ],
    [
      'a value that is not a number',
      { family: 'evm', chainId: 143, to: DEPOSIT, data: '0x', value: 'lots' },
    ],
    ['another family', { family: 'solana', transaction: 'AAAA' }],
  ])('refuses %s on Monad without touching the wallet', async (_name, payload) => {
    const { monadAdapter } = await adapters()
    await expect(monadAdapter.signPrepared?.(payload)).resolves.toMatchObject({
      ok: false,
      reason: 'wallet_error',
    })
    expect(wallet.calls).toEqual([])
  })
})
