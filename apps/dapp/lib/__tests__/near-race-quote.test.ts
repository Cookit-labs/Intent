import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { earnVenue } from '../chains/near/earn'
import { clearTokenCache } from '../chains/near/oneclick'
import { metapoolVenue, rnearVenue } from '../chains/near/stake'
import { oneClickVenue } from '../chains/near/swap'
import { METAPOOL_CONTRACT, RNEAR_CONTRACT, USDC_NEAR } from '../chains/near/tokens'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'

vi.mock('../chains/near/quote-signature', () => ({
  verifyQuoteSignature: vi.fn(() => true),
}))

const ME = 'alice.near'
const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'

type Json = Record<string, unknown>

interface Sim {
  quotes: Json[]
  override: ((body: Json) => { status: number; json: unknown } | Json | undefined) | undefined
  apy: unknown
  apyDown: boolean
  views: Record<string, unknown>
}

let sim: Sim

function goodQuote(body: Json): Json {
  const amount = body['amount'] as string
  const inDollars = Number(amount) / 1e6
  const outDollars = inDollars * 0.995
  const toNear = body['destinationAsset'] === 'nep141:wrap.near'
  const out = toNear
    ? BigInt(Math.round((outDollars / 4) * 1e6)) * BigInt('1000000000000000000')
    : BigInt(Math.round(outDollars * 1e6)) * BigInt('1000000000000')
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: '1',
      amountInUsd: String(inDollars),
      minAmountIn: amount,
      amountOut: out.toString(),
      amountOutFormatted: 'x',
      amountOutUsd: String(outDollars),
      minAmountOut: ((out * BigInt(99)) / BigInt(100)).toString(),
      timeEstimate: 20,
      refundFee: '0',
      withdrawFee: '0',
      ...(body['dry'] === true
        ? {}
        : { depositAddress: DEPOSIT, deadline: '2026-11-06T00:00:00.000Z' }),
    },
    quoteRequest: { ...body, appFees: [{ recipient: 'fee.near', fee: 20 }] },
    signature: 'ed25519:x',
    timestamp: '2026-11-03T00:00:00.000Z',
  }
}

beforeEach(() => {
  clearTokenCache()
  sim = {
    quotes: [],
    override: undefined,
    apy: '4.5',
    apyDown: false,
    views: {
      [`${RNEAR_CONTRACT}.ft_price`]: '1000000000000000000000000',
      [`${METAPOOL_CONTRACT}.get_st_near_price`]: '2000000000000000000000000',
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown, status = 200): Response =>
        new Response(JSON.stringify(data), { status })
      if (url.endsWith('/get-rnear-apy')) {
        if (sim.apyDown) throw new Error('down')
        return json({ code: 0, data: sim.apy })
      }
      if (url.endsWith('/v0/tokens')) {
        const priceUpdatedAt = new Date().toISOString()
        return json([
          { assetId: 'nep141:wrap.near', decimals: 24, symbol: 'wNEAR', price: 4, priceUpdatedAt },
          { assetId: `nep141:${USDC_NEAR}`, decimals: 6, symbol: 'USDC', price: 1, priceUpdatedAt },
          {
            assetId: 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near',
            decimals: 18,
            symbol: 'gtUSDCp',
            price: 1,
            priceUpdatedAt,
          },
        ])
      }
      if (url.endsWith('/v0/quote')) {
        const body = JSON.parse(init?.body as string) as Json
        sim.quotes.push(body)
        const over = sim.override?.(body)
        if (over !== undefined && 'status' in over) {
          return json(over['json'], over['status'] as number)
        }
        return json(over ?? goodQuote(body), 201)
      }
      const rpc = JSON.parse(init?.body as string) as {
        params: { account_id: string; method_name: string }
      }
      const key = `${rpc.params.account_id}.${rpc.params.method_name}`
      if (!(key in sim.views)) return json({ result: { error: `no ${key}` } })
      return json({ result: { result: [...Buffer.from(JSON.stringify(sim.views[key]))] } })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const swap: ChainActionRequest = {
  kind: 'swap',
  amount: '1',
  tokenIn: 'USDC',
  tokenOut: 'NEAR',
  venue: '1click',
}
const supply: ChainActionRequest = { kind: 'supply', amount: '1', tokenIn: 'USDC' }
const stake: ChainActionRequest = { kind: 'stake', amount: '2', tokenIn: 'NEAR' }

describe('quoting the 1Click swap for the race', () => {
  it('asks for one dry quote and returns what it would give back', async () => {
    const quoted = await oneClickVenue.quote?.(swap, ME)
    expect(sim.quotes).toHaveLength(1)
    expect(sim.quotes[0]).toMatchObject({ dry: true, originAsset: `nep141:${USDC_NEAR}` })
    expect(quoted?.receive?.symbol).toBe('NEAR')
    expect(quoted?.valueOutUsd).toBeCloseTo(0.995)
  })

  it('never carries a deposit address, even if 1Click sends one', async () => {
    sim.override = (body) => {
      const full = goodQuote({ ...body, dry: false })
      return { ...full, quoteRequest: { ...body } }
    }
    const quoted = await oneClickVenue.quote?.(swap, ME)
    expect(JSON.stringify(quoted)).not.toContain(DEPOSIT)
    expect(quoted).not.toHaveProperty('depositAddress')
  })

  it('refuses a quote that does not say what was asked', async () => {
    sim.override = (body) => {
      const good = goodQuote(body) as { quoteRequest: Json }
      return { ...good, quoteRequest: { ...good.quoteRequest, recipient: 'mallory.near' } }
    }
    await expect(oneClickVenue.quote?.(swap, ME)).rejects.toThrow(/didn't match/)
  })

  it('refuses a quote that gives back too little', async () => {
    sim.override = (body) => {
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, amountOutUsd: '0.5' } }
    }
    await expect(oneClickVenue.quote?.(swap, ME)).rejects.toThrow(/less than you pay/)
  })
})

describe('quoting the stake venues for the race', () => {
  it('rNEAR returns the receipt amount and the rate from Rhea', async () => {
    const quoted = await rnearVenue.quote?.(stake, ME)
    expect(quoted).toEqual({ receive: { amount: '2', symbol: 'rNEAR' }, apyPercent: 4.5 })
  })

  it('rNEAR gives no rate when Rhea cannot be read, rather than inventing one', async () => {
    sim.apyDown = true
    const quoted = await rnearVenue.quote?.(stake, ME)
    expect(quoted?.receive?.symbol).toBe('rNEAR')
    expect(quoted).not.toHaveProperty('apyPercent')
  })

  it('Meta Pool returns the receipt amount and no rate, because none can be read', async () => {
    const quoted = await metapoolVenue.quote?.(stake, ME)
    expect(quoted).toEqual({ receive: { amount: '1', symbol: 'stNEAR' } })
  })

  it('throws when the contract cannot be read', async () => {
    sim.views = {}
    await expect(rnearVenue.quote?.(stake, ME)).rejects.toThrow(/could not be read/)
    await expect(metapoolVenue.quote?.(stake, ME)).rejects.toThrow(/could not be read/)
  })
})

describe('quoting 1Click Earn for the race', () => {
  it('uses a dry quote, returns the vault share, and no deposit address', async () => {
    const quoted = await earnVenue.quote?.(supply, ME)
    expect(sim.quotes.map((q) => q['dry'])).toEqual([true])
    expect(quoted?.receive?.symbol).toBe('gtUSDCp')
    expect(quoted).not.toHaveProperty('depositAddress')
    expect(quoted).not.toHaveProperty('apyPercent')
  })
})

describe('1Click in a race for NEAR', () => {
  const toNear: ChainActionRequest = {
    kind: 'swap',
    amount: '1',
    tokenIn: 'USDC',
    tokenOut: 'NEAR',
  }

  it('stays out unless named, because it pays wNEAR and a person asked for NEAR', async () => {
    await expect(oneClickVenue.quote?.(toNear, ME)).rejects.toThrow(ChainActionRefused)
    expect(sim.quotes).toHaveLength(0)
  })

  it('answers when a person names it', async () => {
    await expect(oneClickVenue.quote?.({ ...toNear, venue: '1click' }, ME)).resolves.toMatchObject({
      receive: { symbol: 'NEAR' },
    })
  })
})
