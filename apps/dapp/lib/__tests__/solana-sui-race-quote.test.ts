import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { quoteChainRoutes } from '../agents/chain-routes'
import { clearTokenCache } from '../chains/near/oneclick'
import { oneClickOriginVenue } from '../chains/oneclick-origin'
import {
  CAPTURE_ACCOUNT,
  JUPITER_SOL_TO_USDC,
} from '../chains/solana/__fixtures__/captured-transactions'
import { createJupiterLendVenue } from '../chains/solana/jupiter-lend'
import { createJupiterSwapVenue } from '../chains/solana/jupiter-swap'
import { createKaminoVenue } from '../chains/solana/kamino'
import { createLuloVenue } from '../chains/solana/lulo'
import { buildSolanaVenues, solanaModule } from '../chains/solana/module'
import { solanaVenues } from '../chains/solana/venues'
import { cetusVenue } from '../chains/sui/cetus'
import { suiModule } from '../chains/sui/module'
import { naviVenue } from '../chains/sui/navi'
import { springsuiVenue } from '../chains/sui/springsui'
import { suiVenues } from '../chains/sui/venues'
import { ChainActionRefused, type ChainModule } from '../chains/types'
import { capabilitySheet } from '../orchestrate/capabilities'

const sui = vi.hoisted(() => ({
  findRouters: vi.fn(),
  fastRouterSwap: vi.fn(),
  getPools: vi.fn(),
  depositCoinPTB: vi.fn(),
  simulateTransaction: vi.fn(),
  buildUnsigned: vi.fn(),
}))

vi.mock('@cetusprotocol/aggregator-sdk', () => ({
  AggregatorClient: class {
    findRouters = sui.findRouters
    fastRouterSwap = sui.fastRouterSwap
  },
}))

vi.mock('@naviprotocol/lending', () => ({
  getPools: sui.getPools,
  depositCoinPTB: sui.depositCoinPTB,
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({ core: { simulateTransaction: sui.simulateTransaction } }),
  buildUnsigned: sui.buildUnsigned,
}))

vi.mock('../chains/sui/price', () => ({
  priceFromLlama: async (token: { symbol: string }) => (token.symbol === 'SUI' ? 2 : 1),
}))

vi.mock('../chains/near/quote-signature', () => ({
  verifyQuoteSignature: vi.fn(() => true),
}))

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SUI_ME = `0x${'a1'.padStart(64, '0')}`
const USDC_SUI = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined

function stubFetch(route: Route): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init !== undefined ? { init } : {}) })
    const answer = route(url, init)
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`)
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  })
  return { calls }
}

beforeEach(() => {
  clearTokenCache()
  for (const mock of Object.values(sui)) mock.mockReset()
  vi.stubEnv('AUTH_SECRET', 'x'.repeat(48))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Jupiter quote', () => {
  const order = {
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '10000000',
    outAmount: '931580',
    otherAmountThreshold: '922264',
    slippageBps: 100,
    priceImpact: -0.0097,
    router: 'metis',
    gasless: false,
    signatureFeePayer: CAPTURE_ACCOUNT,
    requestId: 'request-1',
    taker: CAPTURE_ACCOUNT,
    transaction: JUPITER_SOL_TO_USDC,
  }
  const request = { kind: 'swap', amount: '0.01', tokenIn: 'SOL', tokenOut: 'USDC' } as const
  const venue = () =>
    createJupiterSwapVenue({
      priceUsd: async (t) => (t.symbol === 'SOL' ? 93 : 1),
      env: {},
      retryDelayMs: 0,
    })

  it('asks /swap/v2/order as the account and returns what comes back, not the transaction', async () => {
    const { calls } = stubFetch(() => ({ body: order }))
    const quoted = await venue().quote?.(request, CAPTURE_ACCOUNT)
    expect(quoted).toEqual({ receive: { amount: '0.93158', symbol: 'USDC' } })
    expect(quoted).not.toHaveProperty('transaction')
    expect(JSON.stringify(quoted)).not.toContain(JUPITER_SOL_TO_USDC)
    const url = new URL(calls[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://api.jup.ag/swap/v2/order')
    expect(url.searchParams.get('taker')).toBe(CAPTURE_ACCOUNT)
    expect(calls).toHaveLength(1)
  })

  it('refuses what prepare would refuse, so the race never offers it', async () => {
    stubFetch(() => ({ body: { ...order, priceImpact: -3.5 } }))
    await expect(venue().quote?.(request, CAPTURE_ACCOUNT)).rejects.toThrow(/price impact/i)
    stubFetch(() => ({ body: { ...order, router: 'unknown' } }))
    await expect(venue().quote?.(request, CAPTURE_ACCOUNT)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
  })
})

describe('Solana supply quotes', () => {
  const supply = { kind: 'supply', amount: '10', tokenIn: 'USDC' } as const

  it('gives Jupiter Lend’s rate from its own reader, without building a deposit', async () => {
    const { calls } = stubFetch(() => ({
      body: [{ assetAddress: USDC, supplyRate: '504', rewardsRate: '100' }],
    }))
    const quoted = await createJupiterLendVenue({ env: {} }).quote?.(supply, CAPTURE_ACCOUNT)
    expect(quoted).toEqual({ apyPercent: 6.04 })
    expect(calls.every((c) => !c.url.includes('/earn/deposit'))).toBe(true)
  })

  it('leaves the rate out when it cannot be read, rather than inventing one', async () => {
    stubFetch(() => ({ status: 500, body: {} }))
    await expect(
      createJupiterLendVenue({ env: {} }).quote?.(supply, CAPTURE_ACCOUNT)
    ).resolves.toEqual({})
  })

  it('refuses a token Jupiter Lend would refuse', async () => {
    await expect(
      createJupiterLendVenue({ env: {} }).quote?.({ ...supply, tokenIn: 'SOL' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/USDC or USDT/)
  })

  const vault = {
    address: 'vault-1',
    state: { name: 'Prime', tokenMint: USDC, prevAum: '1000', minDepositAmount: '1000000' },
  }

  it('gives Kamino’s rate for the vault it would use', async () => {
    const { calls } = stubFetch((url) =>
      url.endsWith('/kvaults/vaults')
        ? { body: [vault] }
        : { body: { apy: '0.05', apyFarmRewards: '0.01' } }
    )
    const quoted = await createKaminoVenue({ cacheMs: 0 }).quote?.(supply, CAPTURE_ACCOUNT)
    expect(quoted?.apyPercent).toBeCloseTo(6, 6)
    expect(calls.every((c) => !c.url.includes('/ktx/'))).toBe(true)
  })

  it('refuses an amount under Kamino’s vault minimum, as prepare would', async () => {
    stubFetch(() => ({ body: [vault] }))
    await expect(
      createKaminoVenue({ cacheMs: 0 }).quote?.({ ...supply, amount: '0.5' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/at least/)
  })

  it('leaves Kamino’s rate out when its metrics cannot be read', async () => {
    stubFetch((url) =>
      url.endsWith('/kvaults/vaults') ? { body: [vault] } : { status: 500, body: {} }
    )
    await expect(
      createKaminoVenue({ cacheMs: 0 }).quote?.(supply, CAPTURE_ACCOUNT)
    ).resolves.toEqual({})
  })

  it('gives Lulo’s rate, without building a deposit', async () => {
    const { calls } = stubFetch(() => ({ body: { protected: { CURRENT: 7.5 } } }))
    await expect(
      createLuloVenue({ apiKey: 'k' }).quote?.(supply, CAPTURE_ACCOUNT)
    ).resolves.toEqual({ apyPercent: 7.5 })
    expect(calls.every((c) => !c.url.includes('deposit'))).toBe(true)
  })

  it('refuses a token Lulo would refuse', async () => {
    await expect(
      createLuloVenue({ apiKey: 'k' }).quote?.({ ...supply, tokenIn: 'USDT' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/USDC deposits only/)
  })
})

describe('Cetus quote', () => {
  const request = { kind: 'swap', amount: '10', tokenIn: 'USDC', tokenOut: 'SUI' } as const
  const route = {
    amountIn: { toString: () => '10000000' },
    amountOut: { toString: () => '4950000000' },
    deviationRatio: '0.001',
    paths: [{}],
  }

  it('returns its best route without building a transaction', async () => {
    sui.findRouters.mockResolvedValue(route)
    await expect(cetusVenue.quote?.(request, SUI_ME)).resolves.toEqual({
      receive: { amount: '4.95', symbol: 'SUI' },
    })
    expect(sui.fastRouterSwap).not.toHaveBeenCalled()
    expect(sui.buildUnsigned).not.toHaveBeenCalled()
  })

  it('refuses a route that was not found, or that prepare would refuse', async () => {
    sui.findRouters.mockResolvedValue(null)
    await expect(cetusVenue.quote?.(request, SUI_ME)).rejects.toThrow(/couldn't find a route/)
    sui.findRouters.mockResolvedValue({ ...route, deviationRatio: '0.2' })
    await expect(cetusVenue.quote?.(request, SUI_ME)).rejects.toThrow(/move the price/)
  })
})

describe('NAVI quote', () => {
  const supply = { kind: 'supply', amount: '10', tokenIn: 'USDC' } as const
  const pool = {
    suiCoinType: USDC_SUI,
    isDeprecated: false,
    leftSupply: '1000',
    totalSupplyAmount: '1',
    borrowedAmount: '0',
    supplyIncentiveApyInfo: { vaultApr: '8.156', boostedApr: '0.344' },
  }

  it('gives the pool’s rate from NAVI’s own fields, without building a deposit', async () => {
    sui.getPools.mockResolvedValue([pool])
    const quoted = await naviVenue.quote?.(supply, SUI_ME)
    expect(quoted?.apyPercent).toBeCloseTo(8.5, 6)
    expect(sui.depositCoinPTB).not.toHaveBeenCalled()
    expect(sui.buildUnsigned).not.toHaveBeenCalled()
  })

  it('leaves the rate out when NAVI gives none', async () => {
    sui.getPools.mockResolvedValue([{ ...pool, supplyIncentiveApyInfo: {} }])
    await expect(naviVenue.quote?.(supply, SUI_ME)).resolves.toEqual({})
  })

  it('refuses a closed pool, a full pool and another token', async () => {
    sui.getPools.mockResolvedValue([{ ...pool, isDeprecated: true }])
    await expect(naviVenue.quote?.(supply, SUI_ME)).rejects.toThrow(/isn't open/)
    sui.getPools.mockResolvedValue([{ ...pool, leftSupply: '5' }])
    await expect(naviVenue.quote?.(supply, SUI_ME)).rejects.toThrow(/only has room/)
    await expect(naviVenue.quote?.({ ...supply, tokenIn: 'SUI' }, SUI_ME)).rejects.toThrow(
      /takes USDC/
    )
  })
})

describe('SpringSui quote', () => {
  const stake = { kind: 'stake', amount: '1', tokenIn: 'SUI' } as const

  it('says what the stake mints, and carries no rate because none can be read', async () => {
    sui.buildUnsigned.mockResolvedValue('AAAA')
    const { SSUI_TYPE } = await import('../chains/sui/policies')
    sui.simulateTransaction.mockResolvedValue({
      Transaction: {
        balanceChanges: [{ coinType: SSUI_TYPE, address: SUI_ME, amount: '963360812' }],
      },
    })
    const quoted = await springsuiVenue.quote?.(stake, SUI_ME)
    expect(quoted).toEqual({ receive: { amount: '0.96336', symbol: 'sSUI' } })
    expect(quoted).not.toHaveProperty('apyPercent')
    expect(JSON.stringify(quoted)).not.toContain('AAAA')
  })

  it('refuses another token', async () => {
    await expect(springsuiVenue.quote?.({ ...stake, tokenIn: 'USDC' }, SUI_ME)).rejects.toThrow(
      /stakes SUI/
    )
  })
})

describe('the race on these chains', () => {
  const priceUpdatedAt = (): string => new Date().toISOString()
  const list = () => [
    {
      assetId: 'nep141:sol-usdc',
      blockchain: 'sol',
      symbol: 'USDC',
      decimals: 6,
      price: 1,
      priceUpdatedAt: priceUpdatedAt(),
      contractAddress: USDC,
    },
    {
      assetId: 'nep141:sol',
      blockchain: 'sol',
      symbol: 'SOL',
      decimals: 9,
      price: 100,
      priceUpdatedAt: priceUpdatedAt(),
    },
  ]

  function chainApi(): ChainModule {
    return {
      ...solanaModule,
      priceUsd: async () => 1,
      venues: [
        createJupiterSwapVenue({
          priceUsd: async (t) => (t.symbol === 'SOL' ? 100 : 1),
          env: {},
          retryDelayMs: 0,
        }),
        oneClickOriginVenue('solana'),
      ],
    }
  }

  function stubBoth(order: Record<string, unknown>): Record<string, unknown>[] {
    const quotes: Record<string, unknown>[] = []
    stubFetch((url, init) => {
      if (url.includes('/swap/v2/order')) return { body: order }
      if (url.endsWith('/v0/tokens')) return { body: list() }
      if (url.endsWith('/v0/quote')) {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>
        quotes.push(body)
        return {
          status: 201,
          body: {
            quote: {
              amountIn: body['amount'],
              amountInFormatted: '1',
              amountInUsd: '1',
              minAmountIn: body['amount'],
              amountOut: '10000000',
              amountOutFormatted: '0.01',
              amountOutUsd: '0.99',
              minAmountOut: '9900000',
            },
            quoteRequest: body,
            signature: 'ed25519:x',
            timestamp: '2026-11-04T00:00:00.000Z',
          },
        }
      }
      return undefined
    })
    return quotes
  }

  const baseOrder = {
    slippageBps: 100,
    priceImpact: -0.01,
    router: 'metis',
    gasless: false,
    signatureFeePayer: CAPTURE_ACCOUNT,
    requestId: 'r',
    taker: CAPTURE_ACCOUNT,
    transaction: JUPITER_SOL_TO_USDC,
  }

  it('races Jupiter against 1Click on a dry quote for USDC to SOL', async () => {
    const quotes = stubBoth({
      ...baseOrder,
      inputMint: USDC,
      outputMint: SOL,
      inAmount: '1000000',
      outAmount: '10000000',
      otherAmountThreshold: '9900000',
    })
    const routes = await quoteChainRoutes(
      chainApi(),
      { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SOL' },
      CAPTURE_ACCOUNT
    )
    expect(routes.map((r) => r.id)).toEqual(['jupiter-1', '1click-solana-1'])
    expect(quotes.map((q) => q['dry'])).toEqual([true])
  })

  it('leaves SOL input to Jupiter alone, with 1Click dropped from the race', async () => {
    const quotes = stubBoth({
      ...baseOrder,
      inputMint: SOL,
      outputMint: USDC,
      inAmount: '10000000',
      outAmount: '1000000',
      otherAmountThreshold: '990000',
    })
    const routes = await quoteChainRoutes(
      chainApi(),
      { kind: 'swap', amount: '0.01', tokenIn: 'SOL', tokenOut: 'USDC' },
      CAPTURE_ACCOUNT
    )
    expect(routes.map((r) => r.id)).toEqual(['jupiter-1'])
    expect(quotes).toHaveLength(0)
  })

  it('wires 1Click as a swap venue on both chains, keeping the defaults', () => {
    expect(buildSolanaVenues({}).find((v) => v.id === '1click-solana')?.kinds).toEqual(['swap'])
    expect(suiModule.venues.find((v) => v.id === '1click-sui')?.kinds).toEqual(['swap'])
    expect(solanaModule.defaultVenue.swap).toBe('jupiter')
    expect(suiModule.defaultVenue.swap).toBe('cetus')
  })

  it('gives every venue on these chains a quote to race with', () => {
    const lulo = createLuloVenue({ apiKey: 'k' })
    for (const venue of [...buildSolanaVenues({}), lulo, ...suiModule.venues]) {
      expect(venue.quote, venue.id).toBeTypeOf('function')
    }
  })

  it('lists 1Click on the Apps page of both chains', () => {
    expect(solanaVenues.find((v) => v.id === '1click-solana')?.integration).toBe('executes')
    expect(suiVenues.find((v) => v.id === '1click-sui')?.integration).toBe('executes')
  })

  it('says agents compete on Solana and Sui, and nothing these chains cannot do', () => {
    const solana = capabilitySheet('solana')
    expect(solana).toContain('Agents compete')
    expect(solana).not.toMatch(/Stake:|Send:|limit order/)
    const onSui = capabilitySheet('sui')
    expect(onSui).toContain('Agents compete')
    expect(onSui).toContain('Stake:')
    expect(onSui).not.toMatch(/Send:|limit order/)
  })
})
