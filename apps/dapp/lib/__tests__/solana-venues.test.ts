import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
} from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import { solanaCapabilities } from '../chains/solana/capabilities'
import { decodeSolanaTransaction } from '../chains/solana/assert-safe'
import { createJupiterLendVenue } from '../chains/solana/jupiter-lend'
import { createJupiterSwapVenue } from '../chains/solana/jupiter-swap'
import { createKaminoVenue } from '../chains/solana/kamino'
import { buildSolanaVenues, solanaModule } from '../chains/solana/module'
import { createLuloVenue } from '../chains/solana/lulo'
import { createPriceSource } from '../chains/solana/price'
import { JUPITER_LEND_PROGRAM } from '../chains/solana/programs'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { solanaVenues } from '../chains/solana/venues'
import {
  CAPTURE_ACCOUNT,
  JUPITER_LEND_USDC_DEPOSIT,
  JUPITER_SOL_TO_USDC,
  JUPITER_USDC_TO_ONYC,
  KAMINO_USDC_DEPOSIT,
  LULO_USDC_DEPOSIT,
} from '../chains/solana/__fixtures__/captured-transactions'
import { ChainActionRefused } from '../chains/types'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const ONYC = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5'

/** The captured deposit with its recipient token account pointed at someone else's. */
function lendDepositWithRecipientSwapped(): string {
  const { messageBytes } = getTransactionDecoder().decode(
    Buffer.from(JUPITER_LEND_USDC_DEPOSIT, 'base64')
  )
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 'legacy') throw new Error('Expected the captured legacy transaction.')
  const deposit = message.instructions[0]
  const recipientIndex = deposit?.accountIndices?.[2] as number
  const staticAccounts = [...message.staticAccounts]
  staticAccounts[recipientIndex] =
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as (typeof staticAccounts)[number]
  const bytes = getCompiledTransactionMessageEncoder().encode({ ...message, staticAccounts })
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(bytes)]).toString('base64')
}

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tokens', () => {
  it('holds exact mints confirmed from a primary source', () => {
    expect(Object.fromEntries(SOLANA_TOKENS.map((t) => [t.symbol, [t.id, t.decimals]]))).toEqual({
      SOL: [SOL, 9],
      USDC: [USDC, 6],
      USDT: [USDT, 6],
      JitoSOL: ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 9],
      ONyc: [ONYC, 9],
    })
  })

  it('never reaches a look-alike symbol outside the list', async () => {
    await expect(
      prepareChainAction(
        solanaModule,
        { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'USDC.e' },
        CAPTURE_ACCOUNT,
        {}
      )
    ).rejects.toThrow(/verified token/)
    await expect(
      prepareChainAction(
        solanaModule,
        { kind: 'swap', amount: '1', tokenIn: USDC, tokenOut: 'SOL' },
        CAPTURE_ACCOUNT,
        {}
      )
    ).rejects.toThrow(/verified token/)
  })
})

describe('price source', () => {
  const prices = { [USDC]: { usdPrice: 0.9994 }, [SOL]: { usdPrice: 93.19 } }
  const usdc = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')!
  const sol = SOLANA_TOKENS.find((t) => t.symbol === 'SOL')!
  const usdt = SOLANA_TOKENS.find((t) => t.symbol === 'USDT')!

  it('uses the live price rather than assuming a stablecoin is a dollar', async () => {
    stubFetch(() => ({ body: prices }))
    await expect(createPriceSource({})(usdc)).resolves.toBe(0.9994)
  })

  it('returns nothing for a token the source leaves out', async () => {
    stubFetch(() => ({ body: prices }))
    await expect(createPriceSource({})(usdt)).resolves.toBeUndefined()
  })

  it('returns nothing, never a guess, when the source fails', async () => {
    stubFetch(() => ({ status: 500, body: {} }))
    await expect(createPriceSource({ retryDelayMs: 0 })(usdc)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', async () => {
      throw new Error('down')
    })
    await expect(createPriceSource({ retryDelayMs: 0 })(usdc)).resolves.toBeUndefined()
  })

  it('refuses a price that is not a positive number', async () => {
    stubFetch(() => ({ body: { [USDC]: { usdPrice: 0 }, [SOL]: { usdPrice: 'nan' } } }))
    await expect(createPriceSource({})(usdc)).resolves.toBeUndefined()
  })

  it('fetches once for all tokens, so a keyless rate limit is not spent per token', async () => {
    const { calls } = stubFetch(() => ({ body: prices }))
    const price = createPriceSource({})
    await Promise.all([price(usdc), price(sol)])
    await price(usdc)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain(ONYC)
  })
})

describe('jupiter swap', () => {
  const order = {
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '10000000',
    outAmount: '931580',
    otherAmountThreshold: '922264',
    slippageBps: 100,
    priceImpact: -0.0097,
    feeBps: 2,
    router: 'metis',
    gasless: false,
    signatureFeePayer: CAPTURE_ACCOUNT,
    rentFeeLamports: 0,
    requestId: 'request-1',
    taker: CAPTURE_ACCOUNT,
    transaction: JUPITER_SOL_TO_USDC,
  }
  const request = { kind: 'swap', amount: '0.01', tokenIn: 'SOL', tokenOut: 'USDC' } as const
  const priceUsd = async (token: { symbol: string }): Promise<number | undefined> =>
    ({ SOL: 93.19, USDC: 0.9994, ONyc: 1.1555 })[token.symbol]

  function venue(env: Record<string, string> = {}, price = priceUsd) {
    return createJupiterSwapVenue({ priceUsd: price, env, retryDelayMs: 0 })
  }

  function answering(overrides: Record<string, unknown>) {
    return stubFetch(() => ({ body: { ...order, ...overrides } }))
  }

  it('builds an action from a real captured route', async () => {
    const { calls } = answering({})
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared).toMatchObject({
      venueId: 'jupiter',
      kind: 'swap',
      pay: { amount: '0.01', symbol: 'SOL' },
      receive: { amount: '0.93158', symbol: 'USDC', approximate: true },
      signing: { family: 'solana', transaction: JUPITER_SOL_TO_USDC },
      context: { requestId: 'request-1' },
    })
    expect(prepared.notes.length).toBeGreaterThanOrEqual(1)
    expect(prepared.notes.length).toBeLessThanOrEqual(3)
    expect(prepared.notes.join(' ')).toContain('0.922264')

    const url = new URL(calls[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://api.jup.ag/swap/v2/order')
    expect(url.searchParams.get('taker')).toBe(CAPTURE_ACCOUNT)
    expect(url.searchParams.get('slippageBps')).toBe('100')
    expect(url.searchParams.get('excludeRouters')).toBe('jupiterz,dflow,okx')
    expect(url.searchParams.get('referralAccount')).toBeNull()
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBeNull()
  })

  it('sends a key only when one is set', async () => {
    const { calls } = answering({})
    await venue({ JUPITER_API_KEY: 'k' }).prepare(request, CAPTURE_ACCOUNT)
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBe('k')
  })

  it('charges a referral fee only when an account is set, and says so', async () => {
    const { calls } = answering({})
    const prepared = await venue({
      JUPITER_REFERRAL_ACCOUNT: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    }).prepare(request, CAPTURE_ACCOUNT)
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('referralAccount')).toBe(
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
    )
    expect(url.searchParams.get('referralFee')).toBe('50')
    expect(prepared.notes.join(' ')).toMatch(/0\.5%/)
  })

  it('ignores a referral account that is not an address', async () => {
    const { calls } = answering({})
    await venue({ JUPITER_REFERRAL_ACCOUNT: 'not-an-address' }).prepare(request, CAPTURE_ACCOUNT)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('referralAccount')).toBeNull()
  })

  it.each([
    ['price impact over 3%', { priceImpact: -3.01 }, /price impact/i],
    ['no price impact reported', { priceImpact: undefined }, /price impact/i],
    ['a different input mint', { inputMint: USDT }, /not what you asked/i],
    ['a different output mint', { outputMint: USDT }, /not what you asked/i],
    ['a different input amount', { inAmount: '1' }, /not what you asked/i],
    [
      'a different taker',
      { taker: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' },
      /not what you/i,
    ],
    ['slippage over 1%', { slippageBps: 101 }, /slippage/i],
    ['a router this venue excludes', { router: 'jupiterz' }, /route/i],
    [
      'someone else paying fees',
      { signatureFeePayer: 'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB' },
      /0\.01 SOL/,
    ],
    ['a gasless flag', { gasless: true }, /0\.01 SOL/],
    ['no request id', { requestId: undefined }, /could not be/i],
    ['no minimum output', { otherAmountThreshold: undefined }, /could not be/i],
  ])('refuses %s', async (_name, overrides, message) => {
    answering(overrides)
    const attempt = venue().prepare(request, CAPTURE_ACCOUNT)
    await expect(attempt).rejects.toThrow(ChainActionRefused)
    await expect(attempt).rejects.toThrow(message)
  })

  it('refuses a return more than 5% worse than the input is worth', async () => {
    answering({ otherAmountThreshold: String(Math.floor(0.94 * 0.9319 * 1e6)) })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/less than/i)
  })

  it('accepts a return under 5% worse', async () => {
    answering({ otherAmountThreshold: String(Math.floor(0.96 * 0.9319 * 1e6)) })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).resolves.toBeDefined()
  })

  it('refuses when it cannot value either side', async () => {
    answering({})
    const noOut = async (token: { symbol: string }) => (token.symbol === 'USDC' ? undefined : 93.19)
    await expect(venue({}, noOut).prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/value/i)
    const noIn = async (token: { symbol: string }) => (token.symbol === 'SOL' ? undefined : 1)
    await expect(venue({}, noIn).prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/value/i)
  })

  it.each([
    [1, /enough SOL for this swap/i],
    [2, /network fees/i],
    [3, /too small/i],
    [99, /could not build/i],
  ])('explains order error %i', async (errorCode, message) => {
    answering({ transaction: '', errorCode, errorMessage: 'upstream text' })
    const attempt = venue().prepare(request, CAPTURE_ACCOUNT)
    await expect(attempt).rejects.toThrow(message)
    await expect(attempt).rejects.not.toThrow(/upstream text/)
  })

  it('explains a low balance even when no fee payer comes back with it', async () => {
    answering({ transaction: '', errorCode: 1, signatureFeePayer: null })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/enough SOL for this/)
  })

  it('refuses an account that is not a Solana address before calling anyone', async () => {
    const { calls } = answering({})
    await expect(
      venue().prepare(request, '0x0000000000000000000000000000000000000000')
    ).rejects.toThrow(/Solana wallet/)
    expect(calls).toHaveLength(0)
  })

  it('warns that ONyc is not a dollar token and has redemption windows', async () => {
    answering({
      inputMint: USDC,
      outputMint: ONYC,
      inAmount: '10000000',
      outAmount: '8640521185',
      otherAmountThreshold: '8554115973',
      transaction: JUPITER_USDC_TO_ONYC,
    })
    const prepared = await venue().prepare(
      { kind: 'swap', amount: '10', tokenIn: 'USDC', tokenOut: 'onyc' },
      CAPTURE_ACCOUNT
    )
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/not a \$1 token/)
    expect(notes).toMatch(/redemption/i)
  })

  it('retries once when rate limited', async () => {
    let first = true
    stubFetch(() => {
      if (first) {
        first = false
        return { status: 429, body: {} }
      }
      return { body: order }
    })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).resolves.toBeDefined()
  })

  it('tells the user to try again when still rate limited', async () => {
    stubFetch(() => ({ status: 429, body: {} }))
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/busy/i)
  })

  it('tells the user to try again when Jupiter does not answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses a request that is not a swap', async () => {
    answering({})
    await expect(
      venue().prepare({ kind: 'supply', amount: '1', tokenIn: 'USDC' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(ChainActionRefused)
  })
})

describe('jupiter lend', () => {
  const tokens = [
    { assetAddress: USDC, supplyRate: '504', rewardsRate: '25' },
    { assetAddress: USDT, supplyRate: '493', rewardsRate: '0' },
  ]
  const request = { kind: 'supply', amount: '1', tokenIn: 'USDC' } as const

  function venue() {
    return createJupiterLendVenue({ env: {}, retryDelayMs: 0 })
  }

  function answering(rates: unknown = tokens, status = 200) {
    return stubFetch((url) =>
      url.endsWith('/earn/tokens')
        ? { status, body: rates }
        : { body: { transaction: JUPITER_LEND_USDC_DEPOSIT } }
    )
  }

  it('builds a deposit from a real captured transaction and shows the rate', async () => {
    const { calls } = answering()
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared).toMatchObject({
      venueId: 'jupiter-lend',
      kind: 'supply',
      pay: { amount: '1', symbol: 'USDC' },
      apy: { basePercent: 5.04, rewardPercent: 0.25 },
      signing: { family: 'solana' },
    })
    const deposit = calls.find((c) => c.url.endsWith('/earn/deposit'))
    expect(JSON.parse(String(deposit?.init?.body))).toEqual({
      asset: USDC,
      amount: '1000000',
      signer: CAPTURE_ACCOUNT,
    })
  })

  it('opens the receipt token account first, because the live deposit fails without one', async () => {
    answering()
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    if (prepared.signing.family !== 'solana') throw new Error('Expected Solana.')
    const { transaction } = prepared.signing

    const decoded = decodeSolanaTransaction(transaction)
    const original = decodeSolanaTransaction(JUPITER_LEND_USDC_DEPOSIT)
    expect(decoded.instructions).toHaveLength(original.instructions.length + 1)
    const [create, deposit] = decoded.instructions
    const accountAt = (i: number | undefined) => decoded.staticAccounts[i as number]
    expect(accountAt(create?.programIndex)).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    expect(Array.from(create?.data ?? [])).toEqual([1])
    expect(accountAt(create?.accounts[0])).toBe(CAPTURE_ACCOUNT)
    expect(accountAt(create?.accounts[1])).toBe('8bPdc8BkLcmkynzQMaQa11te8AobeWkQNjzVV8qeKJpY')
    expect(accountAt(create?.accounts[2])).toBe(CAPTURE_ACCOUNT)
    expect(accountAt(create?.accounts[3])).toBe('9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D')
    expect(accountAt(deposit?.programIndex)).toBe(JUPITER_LEND_PROGRAM)
    expect(Array.from(deposit?.data ?? [])).toEqual(
      Array.from(original.instructions[0]?.data ?? [])
    )
    expect(decoded.blockhash).toBe(original.blockhash)
    expect(decoded.feePayerSignature).toBeNull()

    expect(() => venue().assertSafe(prepared.signing, CAPTURE_ACCOUNT)).not.toThrow()
    expect(prepared.notes.join(' ')).toMatch(/token account/i)
  })

  it('refuses a deposit whose recipient is not the wallet’s own token account', async () => {
    stubFetch((url) =>
      url.endsWith('/earn/tokens')
        ? { body: tokens }
        : { body: { transaction: lendDepositWithRecipientSwapped() } }
    )
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/recipient|your own/i)
  })

  it('says the API is beta and rates change, and promises nothing', async () => {
    answering()
    const notes = (await venue().prepare(request, CAPTURE_ACCOUNT)).notes.join(' ')
    expect(notes).toMatch(/beta/i)
    expect(notes).toMatch(/rate/i)
    expect(notes).not.toMatch(/guaranteed returns|risk[- ]free/i)
  })

  it('reads the rate in the fraction form the docs show as well as live basis points', async () => {
    answering([{ assetAddress: USDC, supplyRate: '0.025', rewardsRate: '0.035' }])
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared.apy?.basePercent).toBeCloseTo(2.5)
    expect(prepared.apy?.rewardPercent).toBeCloseTo(3.5)
  })

  it('still builds, and says so, when the rate cannot be read', async () => {
    answering({}, 500)
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared.apy).toBeUndefined()
    expect(prepared.notes.join(' ')).toMatch(/current rate/i)
  })

  it('refuses a token this venue does not take', async () => {
    const { calls } = answering()
    await expect(
      venue().prepare({ kind: 'supply', amount: '1', tokenIn: 'SOL' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/USDC/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a deposit whose amount differs from the request', async () => {
    answering()
    await expect(venue().prepare({ ...request, amount: '2' }, CAPTURE_ACCOUNT)).rejects.toThrow(
      /amount/i
    )
  })

  it('refuses when no transaction comes back', async () => {
    stubFetch((url) =>
      url.endsWith('/earn/tokens') ? { body: tokens } : { status: 400, body: { error: 'x' } }
    )
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })
})

describe('kamino', () => {
  const KVAULT = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'
  const vault = (address: string, name: string, usdc: number, mint = USDC, programId = KVAULT) => ({
    address,
    programId,
    state: {
      name,
      tokenMint: mint,
      tokenMintDecimals: 6,
      prevAum: String(usdc * 1e6),
      minDepositAmount: '100000',
    },
  })
  const VAULTS = [
    vault('SmallHighApy1111111111111111111111111111111', 'Spiky', 5_000_000),
    vault('DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP', 'RWA USDC', 51_000_000),
    vault('SolVault111111111111111111111111111111111111', 'Big SOL', 900_000_000, SOL),
    vault(
      'Staging11111111111111111111111111111111111111',
      'Staging',
      80_000_000,
      USDC,
      'stKvQfwRsQiKnLtMNVLHKS3exFJmZFsgfzBPWHECUYK'
    ),
  ]
  const METRICS = {
    apy: '0.0577',
    apyFarmRewards: '0.01',
    apyIncentives: '0',
    apyReservesIncentives: '0.002',
  }
  const request = { kind: 'supply', amount: '1', tokenIn: 'USDC' } as const

  function venue() {
    return createKaminoVenue({ cacheMs: 0 })
  }

  function answering(vaults: unknown = VAULTS, metricsStatus = 200) {
    return stubFetch((url) => {
      if (url.endsWith('/kvaults/vaults')) return { body: vaults }
      if (url.endsWith('/metrics')) {
        // The small vault has the highest rate, which must not affect the choice.
        return url.includes('SmallHighApy')
          ? { body: { ...METRICS, apy: '0.40' } }
          : { status: metricsStatus, body: METRICS }
      }
      return { body: { transaction: KAMINO_USDC_DEPOSIT } }
    })
  }

  it('chooses the USDC vault with the highest TVL, not the highest rate, and names it', async () => {
    const { calls } = answering()
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    const deposit = calls.find((c) => c.url.endsWith('/ktx/kvault/deposit'))
    expect(JSON.parse(String(deposit?.init?.body))).toEqual({
      wallet: CAPTURE_ACCOUNT,
      kvault: 'DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP',
      amount: '1',
    })
    expect(prepared.summary).toContain('RWA USDC')
    expect(prepared.venueId).toBe('kamino')
    expect(prepared.apy?.basePercent).toBeCloseTo(5.77)
    expect(prepared.apy?.rewardPercent).toBeCloseTo(1.2)
    expect(prepared.signing).toEqual({ family: 'solana', transaction: KAMINO_USDC_DEPOSIT })
  })

  it('leaves out a reward part when there is none', async () => {
    stubFetch((url) => {
      if (url.endsWith('/kvaults/vaults')) return { body: VAULTS }
      if (url.endsWith('/metrics')) {
        return { body: { apy: '0.05', apyFarmRewards: '0', apyIncentives: '0' } }
      }
      return { body: { transaction: KAMINO_USDC_DEPOSIT } }
    })
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared.apy).toEqual({ basePercent: 5 })
  })

  it('still builds, and says so, when the rate cannot be read', async () => {
    answering(VAULTS, 500)
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared.apy).toBeUndefined()
    expect(prepared.notes.join(' ')).toMatch(/current rate/i)
  })

  it('cleans an on-chain vault name before showing it', async () => {
    answering([vault('DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP', 'Vault\u0000<b>x</b>', 1)])
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared.summary).not.toMatch(/[<>\u0000]/)
  })

  it('refuses anything but USDC', async () => {
    const { calls } = answering()
    await expect(
      venue().prepare({ kind: 'supply', amount: '1', tokenIn: 'USDT' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/USDC/)
    expect(calls).toHaveLength(0)
  })

  it('refuses less than the vault’s minimum deposit', async () => {
    answering()
    await expect(venue().prepare({ ...request, amount: '0.01' }, CAPTURE_ACCOUNT)).rejects.toThrow(
      /at least 0\.1 USDC/
    )
  })

  it('refuses when no USDC vault is listed', async () => {
    answering([vault('SolVault111111111111111111111111111111111111', 'Big SOL', 9, SOL)])
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/USDC vault/)
  })

  it('refuses a deposit whose amount differs from the request', async () => {
    answering()
    await expect(venue().prepare({ ...request, amount: '2' }, CAPTURE_ACCOUNT)).rejects.toThrow(
      /amount/i
    )
  })

  it('warns about the curator and withdrawals, and promises nothing', async () => {
    answering()
    const notes = (await venue().prepare(request, CAPTURE_ACCOUNT)).notes
    expect(notes.length).toBeLessThanOrEqual(3)
    expect(notes.join(' ')).toMatch(/curator/i)
    expect(notes.join(' ')).toMatch(/withdraw/i)
  })
})

describe('lulo', () => {
  const request = { kind: 'supply', amount: '1', tokenIn: 'USDC' } as const

  function venue() {
    return createLuloVenue({ apiKey: 'lulo-key' })
  }

  function answering(deposit: unknown = { transaction: LULO_USDC_DEPOSIT }, status = 200) {
    return stubFetch((url) =>
      url.includes('rates.getRates')
        ? { body: { protected: { CURRENT: 4.26 }, regular: { CURRENT: 8.8 } } }
        : { status, body: deposit }
    )
  }

  it('builds from a real captured transaction, in display units, with the key', async () => {
    const { calls } = answering()
    const prepared = await venue().prepare(request, CAPTURE_ACCOUNT)
    expect(prepared).toMatchObject({
      venueId: 'lulo',
      kind: 'supply',
      apy: { basePercent: 4.26 },
      signing: { family: 'solana', transaction: LULO_USDC_DEPOSIT },
    })
    const deposit = calls.find((c) => c.url.endsWith('/v1/generate.transactions.deposit'))
    // Not base units, despite the docs' example: 1000000 here built a $1,000,000 deposit.
    expect(JSON.parse(String(deposit?.init?.body))).toEqual({
      owner: CAPTURE_ACCOUNT,
      mintAddress: USDC,
      protectedAmount: 1,
    })
    expect(new Headers(deposit?.init?.headers).get('x-api-key')).toBe('lulo-key')
    expect(() => venue().assertSafe(prepared.signing, CAPTURE_ACCOUNT)).not.toThrow()
  })

  it('says the cover is depositor-funded first loss and not insurance', async () => {
    answering()
    const notes = (await venue().prepare(request, CAPTURE_ACCOUNT)).notes.join(' ')
    expect(notes).toMatch(/first-loss/i)
    expect(notes).toMatch(/not insurance/i)
  })

  it('refuses a deposit whose amount differs from the request', async () => {
    answering()
    await expect(venue().prepare({ ...request, amount: '2' }, CAPTURE_ACCOUNT)).rejects.toThrow(
      /amount/i
    )
  })

  it('refuses when Lulo’s own simulation failed', async () => {
    answering({ transaction: LULO_USDC_DEPOSIT, simulateError: '{"InstructionError":[1]}' })
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(/balance/i)
  })

  it('refuses anything but USDC', async () => {
    const { calls } = answering()
    await expect(
      venue().prepare({ kind: 'supply', amount: '1', tokenIn: 'SOL' }, CAPTURE_ACCOUNT)
    ).rejects.toThrow(/USDC/)
    expect(calls).toHaveLength(0)
  })

  it('refuses when the key is rejected', async () => {
    answering({ error: 'nope' }, 401)
    await expect(venue().prepare(request, CAPTURE_ACCOUNT)).rejects.toThrow(ChainActionRefused)
  })

  it('does not let its policy pass another venue’s transaction', () => {
    expect(() =>
      venue().assertSafe({ family: 'solana', transaction: KAMINO_USDC_DEPOSIT }, CAPTURE_ACCOUNT)
    ).toThrow(/program/i)
  })

  it('appears only when a key is configured', () => {
    expect(buildSolanaVenues({ LULO_API_KEY: ' ' }).map((v) => v.id)).not.toContain('lulo')
    expect(buildSolanaVenues({ LULO_API_KEY: 'k' }).map((v) => v.id)).toContain('lulo')
  })
})

describe('module', () => {
  it('offers the three venues that need no key', () => {
    expect(buildSolanaVenues({}).map((v) => v.id)).toEqual(['jupiter', 'jupiter-lend', 'kamino'])
    expect(solanaModule.defaultVenue).toMatchObject({ swap: 'jupiter', supply: 'jupiter-lend' })
    expect(solanaModule.chain).toBe('solana')
  })

  it('lets only Jupiter land its own transactions', () => {
    const [swap, lend, kamino] = buildSolanaVenues({})
    expect(swap?.submit).toBeTypeOf('function')
    expect(lend?.submit).toBeUndefined()
    expect(kamino?.submit).toBeUndefined()
  })

  it('refuses a trade over the $500 cap before building anything', async () => {
    const { calls } = stubFetch((url) =>
      url.includes('/price/v3') ? { body: { [USDC]: { usdPrice: 1 } } } : undefined
    )
    const chainApi = { ...solanaModule, priceUsd: async () => 1 }
    await expect(
      prepareChainAction(
        chainApi,
        { kind: 'swap', amount: '501', tokenIn: 'USDC', tokenOut: 'SOL' },
        CAPTURE_ACCOUNT,
        {}
      )
    ).rejects.toThrow(/caps each trade/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a named venue that cannot do this', async () => {
    const chainApi = { ...solanaModule, priceUsd: async () => 1 }
    await expect(
      prepareChainAction(
        chainApi,
        { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SOL', venue: 'kamino' },
        CAPTURE_ACCOUNT,
        {}
      )
    ).rejects.toThrow(/can't swap here/)
  })

  it('routes a supply named by the words a person would use', async () => {
    const seen: string[] = []
    const chainApi = {
      ...solanaModule,
      priceUsd: async () => 1,
      venues: solanaModule.venues.map((v) => ({
        ...v,
        prepare: async () => {
          seen.push(v.id)
          throw new ChainActionRefused('stop')
        },
      })),
    }
    for (const venue of ['Kamino', 'Jupiter Lend']) {
      await prepareChainAction(
        chainApi,
        { kind: 'supply', amount: '1', tokenIn: 'USDC', venue },
        CAPTURE_ACCOUNT,
        {}
      ).catch(() => undefined)
    }
    expect(seen).toEqual(['kamino', 'jupiter-lend'])
  })
})

describe('venues page', () => {
  it('lists every row of the report', () => {
    expect(solanaVenues).toHaveLength(14)
    expect(new Set(solanaVenues.map((v) => v.id)).size).toBe(14)
    for (const v of solanaVenues) {
      expect(v.family).toBe('solana')
      expect(v.chains).toEqual(['Solana'])
      expect(v.url).toMatch(/^https:\/\//)
      expect(v.bestFor.length).toBeGreaterThan(0)
    }
  })

  it('claims execution only for what is wired and on by default', () => {
    const executes = solanaVenues.filter((v) => v.integration === 'executes')
    const wired = buildSolanaVenues({}).map((v) => v.id)
    for (const v of executes) {
      expect(v.capability).toBeTruthy()
      // OnRe has no venue of its own: it is bought through the Jupiter swap venue.
      expect(v.id === 'onre' ? wired.includes('jupiter') : wired.includes(v.id)).toBe(true)
    }
    for (const id of wired) expect(executes.map((v) => v.id)).toContain(id)
  })

  it('keeps Linq on Solana listed', () => {
    expect(solanaVenues.find((v) => v.name.startsWith('Linq'))?.integration ?? 'listed').toBe(
      'listed'
    )
  })

  it('does not collide with the ids of other chains’ venues', () => {
    for (const id of ['phoenix', 'linq', 'blend', 'soroswap']) {
      expect(solanaVenues.map((v) => v.id)).not.toContain(id)
    }
  })
})

describe('capabilities', () => {
  it('has one entry per wired kind, and each example parses and resolves', async () => {
    const kinds = solanaCapabilities.map((c) => c.kind)
    expect(new Set(kinds)).toEqual(new Set(['swap', 'supply']))
    expect(kinds).toHaveLength(2)
    const swap = solanaCapabilities.find((c) => c.kind === 'swap')!
    expect(parseChainAction(`swap 10 USDC to ${swap.symbol}`)).toMatchObject({
      kind: 'swap',
      tokenOut: swap.symbol,
    })
    const supply = solanaCapabilities.find((c) => c.kind === 'supply')!
    expect(parseChainAction(`supply 10 USDC on ${supply.venue}`)).toMatchObject({
      kind: 'supply',
      venue: supply.venue,
    })
  })
})
