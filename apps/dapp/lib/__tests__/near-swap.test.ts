import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearTokenCache } from '../chains/near/oneclick'
import { nearModule } from '../chains/near/module'
import { oneClickVenue, submitOneClick } from '../chains/near/swap'
import { USDC_NEAR, WRAP_NEAR } from '../chains/near/tokens'
import { prepareChainAction } from '../chains/prepare'
import { ChainActionRefused, type ChainActionRequest, type NearTransaction } from '../chains/types'

vi.mock('../chains/near/quote-signature', () => ({
  verifyQuoteSignature: vi.fn(() => true),
}))

import { verifyQuoteSignature } from '../chains/near/quote-signature'
import type { NearFunctionCall } from '../chains/types'

const ME = 'alice.near'
const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'

type Json = Record<string, unknown>

interface Sim {
  /** Each quote request, in order. */
  quotes: Json[]
  quoteHeaders: Record<string, string>[]
  submits: Json[]
  registered: Set<string>
  quoteOverride: (body: Json) => { status?: number; json?: unknown } | Json | undefined
  statuses: (string | undefined)[]
  statusRecipient: string
  tx: (() => unknown) | undefined
}

function tokenList(priceUpdatedAt = new Date().toISOString()): Json[] {
  return [
    { assetId: 'nep141:wrap.near', decimals: 24, symbol: 'wNEAR', price: 4, priceUpdatedAt },
    { assetId: `nep141:${USDC_NEAR}`, decimals: 6, symbol: 'USDC', price: 1, priceUpdatedAt },
    {
      assetId: 'nep141:usdt.tether-token.near',
      decimals: 6,
      symbol: 'USDT',
      price: 1,
      priceUpdatedAt,
    },
    {
      assetId: 'nep141:miden-0x5cb79d29507d3ad17bb6dc60279e89.omft.near',
      decimals: 6,
      symbol: 'USDT',
      price: 0.5,
      priceUpdatedAt,
    },
  ]
}

function goodQuote(body: Json): Json {
  const toNear = body['destinationAsset'] === 'nep141:wrap.near'
  const fromNear = body['originAsset'] === 'nep141:wrap.near'
  const amount = body['amount'] as string
  const inDollars = fromNear ? (Number(amount) / 1e24) * 4 : Number(amount) / 1e6
  const outDollars = inDollars * 0.995
  const out = toNear
    ? BigInt(Math.round((outDollars / 4) * 1e6)) * BigInt('1000000000000000000')
    : BigInt(Math.round(outDollars * 1e6))
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
        : {
            depositAddress: DEPOSIT,
            deadline: '2026-11-06T00:00:00.000Z',
            timeWhenInactive: '2026-11-06T00:00:00.000Z',
          }),
    },
    quoteRequest: { ...body, appFees: [{ recipient: 'fee.near', fee: 20 }] },
    signature: 'ed25519:x',
    timestamp: '2026-11-03T00:00:00.000Z',
  }
}

function installFetch(sim: Sim): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown, status = 200): Response =>
        new Response(JSON.stringify(data), { status })
      if (url.endsWith('/v0/tokens')) return json(tokenList())
      if (url.endsWith('/v0/quote')) {
        const body = JSON.parse(init?.body as string) as Json
        sim.quotes.push(body)
        sim.quoteHeaders.push(init?.headers as Record<string, string>)
        const override = sim.quoteOverride(body)
        if (override !== undefined && 'status' in override) {
          return json(override['json'], override['status'] as number)
        }
        return json(override ?? goodQuote(body), 201)
      }
      if (url.endsWith('/v0/deposit/submit')) {
        sim.submits.push(JSON.parse(init?.body as string) as Json)
        return json({ correlationId: 'c' })
      }
      if (url.includes('/v0/status')) {
        const status = sim.statuses.length > 1 ? sim.statuses.shift() : sim.statuses[0]
        return json({
          status,
          quoteResponse: { quoteRequest: { recipient: sim.statusRecipient } },
        })
      }
      // Everything else is the NEAR RPC.
      const rpc = JSON.parse(init?.body as string) as {
        method: string
        params: { method_name?: string; account_id?: string; args_base64?: string }
      }
      if (rpc.method === 'tx') {
        return json({
          result: sim.tx?.() ?? null,
          error: sim.tx === undefined ? { cause: { name: 'UNKNOWN_TRANSACTION' } } : undefined,
        })
      }
      const args = JSON.parse(Buffer.from(rpc.params.args_base64 ?? '', 'base64').toString()) as {
        account_id: string
      }
      const isIn = sim.registered.has(`${rpc.params.account_id}|${args.account_id}`)
      const bytes = [...Buffer.from(JSON.stringify(isIn ? { total: '1', available: '0' } : null))]
      return json({ result: { result: bytes } })
    })
  )
}

function newSim(): Sim {
  return {
    quotes: [],
    quoteHeaders: [],
    submits: [],
    registered: new Set(),
    quoteOverride: () => undefined,
    statuses: ['SUCCESS'],
    statusRecipient: ME,
    tx: undefined,
  }
}

const swap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'swap',
  amount: '1',
  tokenIn: 'USDC',
  tokenOut: 'NEAR',
  ...over,
})

function txOf(prepared: { signing: unknown }): NearTransaction {
  return (prepared.signing as { transactions: NearTransaction[] })
    .transactions[0] as NearTransaction
}

let sim: Sim

beforeEach(() => {
  clearTokenCache()
  sim = newSim()
  installFetch(sim)
  vi.mocked(verifyQuoteSignature).mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('preparing a 1Click swap', () => {
  it('previews with a dry quote, then asks for the real one with the required fields', async () => {
    await oneClickVenue.prepare(swap(), ME)
    expect(sim.quotes.map((q) => q['dry'])).toEqual([true, false])
    for (const quote of sim.quotes) {
      expect(quote).toMatchObject({
        swapType: 'EXACT_INPUT',
        depositType: 'ORIGIN_CHAIN',
        originAsset: `nep141:${USDC_NEAR}`,
        destinationAsset: 'nep141:wrap.near',
        amount: '1000000',
        refundTo: ME,
        refundType: 'ORIGIN_CHAIN',
        recipient: ME,
        recipientType: 'DESTINATION_CHAIN',
        slippageTolerance: 100,
      })
      const minutes = (Date.parse(quote['deadline'] as string) - Date.now()) / 60_000
      expect(minutes).toBeGreaterThan(3)
      expect(minutes).toBeLessThanOrEqual(5)
    }
  })

  it('builds a storage payment and transfer for a stablecoin, which passes assertSafe', async () => {
    const prepared = await oneClickVenue.prepare(swap(), ME)
    const tx = txOf(prepared)
    expect(tx.receiverId).toBe(USDC_NEAR)
    expect(tx.actions.map((a) => (a as NearFunctionCall).params.methodName)).toEqual([
      'storage_deposit',
      'ft_transfer',
    ])
    expect((tx.actions[1] as NearFunctionCall | undefined)?.params).toMatchObject({
      args: { receiver_id: DEPOSIT, amount: '1000000' },
      deposit: '1',
    })
    expect(prepared.context?.['depositAddress']).toBe(DEPOSIT)
    expect(() => oneClickVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('skips the storage payment when the deposit address is already registered', async () => {
    sim.registered.add(`${USDC_NEAR}|${DEPOSIT}`)
    const tx = txOf(await oneClickVenue.prepare(swap(), ME))
    expect(tx.actions.map((a) => (a as NearFunctionCall).params.methodName)).toEqual([
      'ft_transfer',
    ])
  })

  it('wraps NEAR first, and registers an unregistered sender before wrapping', async () => {
    const request = swap({ tokenIn: 'NEAR', tokenOut: 'USDC' })
    const prepared = await oneClickVenue.prepare(request, ME)
    const tx = txOf(prepared)
    expect(tx.receiverId).toBe(WRAP_NEAR)
    expect(tx.actions.map((a) => (a as NearFunctionCall).params.methodName)).toEqual([
      'storage_deposit',
      'near_deposit',
      'storage_deposit',
      'ft_transfer',
    ])
    expect((tx.actions[0] as NearFunctionCall | undefined)?.params.args).toMatchObject({
      account_id: ME,
    })
    expect((tx.actions[1] as NearFunctionCall | undefined)?.params.deposit).toBe(
      '1000000000000000000000000'
    )
    expect((tx.actions[2] as NearFunctionCall | undefined)?.params.args).toMatchObject({
      account_id: DEPOSIT,
    })
    expect(() => oneClickVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('does not register a sender who is already registered on wrap.near', async () => {
    sim.registered.add(`${WRAP_NEAR}|${ME}`)
    const prepared = await oneClickVenue.prepare(swap({ tokenIn: 'NEAR', tokenOut: 'USDC' }), ME)
    expect(txOf(prepared).actions.map((a) => (a as NearFunctionCall).params.methodName)).toEqual([
      'near_deposit',
      'storage_deposit',
      'ft_transfer',
    ])
    expect(() => oneClickVenue.assertSafe(prepared.signing, ME)).not.toThrow()
  })

  it('tells the user about mainnet, the fee and the refund address', async () => {
    const prepared = await oneClickVenue.prepare(swap(), ME)
    const notes = prepared.notes.join(' ')
    expect(notes).toMatch(/mainnet only/)
    expect(notes).toMatch(/0\.20% fee/)
    expect(notes).toContain(ME)
    expect(prepared.notes.length).toBeLessThanOrEqual(3)
    expect(prepared.receive?.approximate).toBe(true)
    expect(notes).not.toMatch(/guarantee/i)
  })

  it('mentions a withdrawal fee and a refund fee when the quote has them', async () => {
    sim.quoteOverride = (body) => {
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, withdrawFee: '4807', refundFee: '100' } }
    }
    const prepared = await oneClickVenue.prepare(swap({ tokenIn: 'NEAR', tokenOut: 'USDT' }), ME)
    expect(prepared.notes.join(' ')).toMatch(/register you on that token/)
    expect(prepared.notes.join(' ')).toMatch(/minus a fee/)
  })

  it('keeps NEAR’s cost sentence word for word', async () => {
    const prepared = await oneClickVenue.prepare(swap(), ME)
    expect(prepared.notes[0]).toMatch(
      /^NEAR Intents runs on mainnet only, so this moves real funds\. .* After all costs you get about [\d.]+% less in value than you pay, and at least /
    )
  })

  it('sends the API key and app fees only when configured', async () => {
    await oneClickVenue.prepare(swap(), ME)
    expect(sim.quoteHeaders[0]).not.toHaveProperty('X-API-Key')
    expect(sim.quotes[0]).not.toHaveProperty('appFees')

    vi.stubEnv('ONECLICK_API_KEY', 'test-key')
    vi.stubEnv('ONECLICK_APP_FEE_BPS', '30')
    vi.stubEnv('ONECLICK_APP_FEE_RECIPIENT', 'fees.intent.near')
    sim.quotes.length = 0
    sim.quoteHeaders.length = 0
    await oneClickVenue.prepare(swap(), ME)
    expect(sim.quoteHeaders[1]).toMatchObject({ 'X-API-Key': 'test-key' })
    expect(sim.quotes[1]?.['appFees']).toEqual([{ recipient: 'fees.intent.near', fee: 30 }])
  })

  it('omits app fees rather than charge on a bad setting', async () => {
    for (const [bps, recipient] of [
      ['abc', 'fees.intent.near'],
      ['476', 'fees.intent.near'],
      ['30', 'NOT VALID'],
      ['30', ''],
    ] as const) {
      vi.stubEnv('ONECLICK_APP_FEE_BPS', bps)
      vi.stubEnv('ONECLICK_APP_FEE_RECIPIENT', recipient)
      sim.quotes.length = 0
      await oneClickVenue.prepare(swap(), ME)
      expect(sim.quotes[0]).not.toHaveProperty('appFees')
    }
  })
})

describe('what 1Click can refuse', () => {
  async function refusal(request: ChainActionRequest = swap()): Promise<string> {
    const error = await oneClickVenue.prepare(request, ME).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ChainActionRefused)
    return (error as ChainActionRefused).message
  }

  it('says "no liquidity" in a plain sentence', async () => {
    sim.quoteOverride = () => ({ status: 400, json: { message: 'No liquidity available' } })
    expect(await refusal()).toMatch(/no price for this right now.*different amount/)
    expect(sim.quotes).toHaveLength(1)
  })

  it('reads a temporary minimum, passing on only the amount', async () => {
    sim.quoteOverride = () => ({
      status: 400,
      json: { message: 'Temporary swap limits: minimum swap amount is $1,000 <b>bad</b>' },
    })
    const message = await refusal()
    expect(message).toMatch(/won't take less than \$1,000/)
    expect(message).not.toContain('<b>')
  })

  it('handles other refusals without echoing what came back', async () => {
    sim.quoteOverride = () => ({ status: 400, json: { message: 'internal stack trace' } })
    expect(await refusal()).not.toContain('stack trace')
    sim.quoteOverride = () => ({ status: 401, json: {} })
    expect(await refusal()).toMatch(/API key/)
    sim.quoteOverride = () => ({ status: 429, json: {} })
    expect(await refusal()).toMatch(/limiting requests/)
  })

  it('refuses when 1Click cannot be reached', async () => {
    const real = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/v0/quote')) throw new Error('timed out')
      return (real as typeof fetch)(input, init)
    })
    expect(await refusal()).toMatch(/isn't answering/)
  })

  it('refuses a dry quote worth over 5% less, and never asks for a deposit address', async () => {
    sim.quoteOverride = (body) => {
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, amountOutUsd: '0.94' } }
    }
    expect(await refusal()).toMatch(/about 6\.0% less/)
    expect(sim.quotes).toHaveLength(1)
  })

  it('accepts a quote at just under 5%', async () => {
    sim.quoteOverride = (body) => {
      const good = goodQuote(body) as { quote: Json }
      return {
        ...good,
        quote: {
          ...good.quote,
          amountOutUsd: '0.951',
          amountOut: '237750000000000000000000',
          minAmountOut: '235372500000000000000000',
        },
      }
    }
    await expect(oneClickVenue.prepare(swap(), ME)).resolves.toBeDefined()
  })

  it('catches a low output even if the quote claims a good dollar figure', async () => {
    sim.quoteOverride = (body) => {
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, amountOut: '1', minAmountOut: '0' } }
    }
    expect(await refusal()).toMatch(/less than you pay/)
  })

  it('refuses the real quote too, if the price worsened after the preview', async () => {
    sim.quoteOverride = (body) => {
      if (body['dry'] === true) return undefined
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, amountOutUsd: '0.5' } }
    }
    expect(await refusal()).toMatch(/less than you pay/)
  })

  it('refuses a stale price rather than valuing on it', async () => {
    const real = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/v0/tokens')) {
        return new Response(JSON.stringify(tokenList('2026-01-01T00:00:00.000Z')))
      }
      return (real as typeof fetch)(input, init)
    })
    expect(await refusal()).toMatch(/couldn't be checked/)
  })

  it('refuses a quote that does not match the request', async () => {
    for (const [field, value] of [
      ['recipient', 'evil.near'],
      ['refundTo', 'evil.near'],
      ['refundType', 'INTENTS'],
      ['recipientType', 'INTENTS'],
      ['amount', '999'],
      ['originAsset', 'nep141:evil.near'],
      ['destinationAsset', 'nep141:evil.near'],
      ['slippageTolerance', 500],
      ['swapType', 'FLEX_INPUT'],
      ['deadline', '2030-01-01T00:00:00.000Z'],
    ] as const) {
      sim.quoteOverride = (body) => {
        if (body['dry'] === true) return undefined
        const good = goodQuote(body) as { quoteRequest: Json }
        return { ...good, quoteRequest: { ...good.quoteRequest, [field]: value } }
      }
      expect(await refusal(), `tampered ${field}`).toMatch(/didn't match/)
    }
  })

  it('refuses amounts in the quote that do not match, or a thin minimum', async () => {
    for (const change of [
      { amountIn: '999' },
      { minAmountIn: '999' },
      { minAmountOut: '0' },
      { amountOut: '0', minAmountOut: '0' },
    ]) {
      sim.quoteOverride = (body) => {
        const good = goodQuote(body) as { quote: Json }
        return { ...good, quote: { ...good.quote, ...change } }
      }
      expect(await refusal()).toMatch(/didn't match/)
    }
  })

  it('refuses a deposit address that is not an implicit account, or that needs a memo', async () => {
    for (const change of [
      { depositAddress: 'evil.near' },
      { depositAddress: undefined },
      { depositAddress: 'A'.repeat(64) },
    ]) {
      sim.quoteOverride = (body) => {
        if (body['dry'] === true) return undefined
        const good = goodQuote(body) as { quote: Json }
        return { ...good, quote: { ...good.quote, ...change } }
      }
      expect(await refusal()).toMatch(/deposit address/)
    }
    sim.quoteOverride = (body) => {
      if (body['dry'] === true) return undefined
      const good = goodQuote(body) as { quote: Json }
      return { ...good, quote: { ...good.quote, depositMemo: '123' } }
    }
    expect(await refusal()).toMatch(/memo/)
  })

  it('refuses a quote with a bad signature', async () => {
    vi.mocked(verifyQuoteSignature).mockReturnValue(false)
    expect(await refusal()).toMatch(/signature check/)
  })

  it('refuses an unreadable quote', async () => {
    sim.quoteOverride = () => ({ quote: { amountIn: 'not digits' } })
    expect(await refusal()).toMatch(/cannot read/)
  })

  it('refuses when the deposit address cannot be checked on NEAR', async () => {
    const real = vi.mocked(fetch).getMockImplementation()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (/fastnear|drpc/.test(String(input))) throw new Error('down')
      return (real as typeof fetch)(input, init)
    })
    expect(await refusal()).toMatch(/could not be read/)
  })

  it('refuses a request that is not a swap, an unknown token, or too many decimals', async () => {
    expect(await refusal(swap({ tokenOut: 'BTC' }))).toMatch(/swaps between/)
    expect(await refusal(swap({ tokenOut: 'USDC' }))).toMatch(/same token/)
    expect(await refusal(swap({ amount: '1.1234567' }))).toMatch(/decimal places/)
    const stellar = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
    await expect(oneClickVenue.prepare(swap(), stellar)).rejects.toThrow(/not a NEAR account/)
    expect(sim.quotes).toHaveLength(0)
  })
})

describe('the whole prepare path for NEAR', () => {
  it('defaults swaps to Rhea, and reaches 1Click when named', async () => {
    expect(nearModule.defaultVenue.swap).toBe('rhea-dex')
    const prepared = await prepareChainAction(nearModule, swap({ venue: '1click' }), ME)
    expect(prepared.venueId).toBe('1click')
  })

  it('refuses an unknown token and a venue that cannot do this', async () => {
    await expect(prepareChainAction(nearModule, swap({ tokenIn: 'DOGE' }), ME)).rejects.toThrow(
      /verified token/
    )
    await expect(prepareChainAction(nearModule, swap({ venue: 'rnear' }), ME)).rejects.toThrow(
      /can't swap here/
    )
  })

  it('reads the price of the exact asset, not another with the same symbol', async () => {
    const usdt = nearModule.tokens.find((t) => t.symbol === 'USDT')
    expect(usdt).toBeDefined()
    await expect(nearModule.priceUsd(usdt as NonNullable<typeof usdt>)).resolves.toBe(1)
  })

  it('has no price for a token 1Click lists with other decimals', async () => {
    const usdc = nearModule.tokens.find((t) => t.symbol === 'USDC')
    await expect(
      nearModule.priceUsd({ ...(usdc as NonNullable<typeof usdc>), decimals: 18 })
    ).resolves.toBeUndefined()
  })

  it('has no price when the token list fails', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('nope', { status: 500 }))
    const usdc = nearModule.tokens.find((t) => t.symbol === 'USDC')
    await expect(nearModule.priceUsd(usdc as NonNullable<typeof usdc>)).resolves.toBeUndefined()
  })
})

describe('submitting a 1Click swap', () => {
  const executed =
    (status: Json, over: Json = {}): (() => unknown) =>
    () => ({
      status,
      transaction: {
        signer_id: ME,
        receiver_id: USDC_NEAR,
        actions: [
          {
            FunctionCall: {
              method_name: 'ft_transfer',
              args: Buffer.from(JSON.stringify({ receiver_id: DEPOSIT, amount: '1' })).toString(
                'base64'
              ),
              deposit: '1',
            },
          },
        ],
        ...over,
      },
    })

  const input = (over: Partial<Parameters<typeof submitOneClick>[0]> = {}) => ({
    account: ME,
    venueId: '1click',
    signed: { family: 'near' as const, hashes: [HASH] },
    context: { depositAddress: DEPOSIT },
    ...over,
  })

  /** Runs a submit with its waits skipped. */
  async function run(over: Parameters<typeof input>[0] = {}) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const pending = submitOneClick(input(over))
    await vi.runAllTimersAsync()
    return pending
  }

  it('reports the deposit with the sender, and returns the explorer link on success', async () => {
    sim.tx = executed({ SuccessValue: '' })
    await expect(run()).resolves.toEqual({
      ok: true,
      hash: HASH,
      explorerUrl: `https://nearblocks.io/txns/${HASH}`,
    })
    expect(sim.submits).toEqual([{ txHash: HASH, depositAddress: DEPOSIT, nearSenderAccount: ME }])
  })

  it('says plainly when the deposit transaction failed on NEAR', async () => {
    sim.tx = executed({ Failure: { ActionError: {} } })
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toMatch(/failed on NEAR.*did not leave/)
    expect(sim.submits).toHaveLength(0)
  })

  it('does not report a hash that is not this account paying this deposit address', async () => {
    sim.tx = executed({ SuccessValue: '' }, { signer_id: 'someone.near' })
    expect(await run()).toMatchObject({ ok: false })
    sim.tx = executed({ SuccessValue: '' }, { actions: [] })
    expect(await run()).toMatchObject({ ok: false })
    expect(sim.submits).toHaveLength(0)
  })

  it('reads a transaction relayed through a delegate action as the real sender', async () => {
    sim.tx = () => ({
      status: { SuccessValue: '' },
      transaction: {
        signer_id: 'relayer.near',
        receiver_id: ME,
        actions: [
          {
            Delegate: {
              delegate_action: {
                sender_id: ME,
                receiver_id: USDC_NEAR,
                actions: [
                  {
                    FunctionCall: {
                      method_name: 'ft_transfer',
                      args: Buffer.from(
                        JSON.stringify({ receiver_id: DEPOSIT, amount: '1' })
                      ).toString('base64'),
                      deposit: '1',
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    })
    await expect(run()).resolves.toMatchObject({ ok: true })
  })

  it('says what happened on REFUNDED, FAILED and INCOMPLETE_DEPOSIT', async () => {
    sim.tx = executed({ SuccessValue: '' })
    for (const [status, words] of [
      ['REFUNDED', /refunded your funds to alice\.near/],
      ['FAILED', /failed after your deposit.*alice\.near/],
      ['INCOMPLETE_DEPOSIT', /less than the quote.*alice\.near/],
    ] as const) {
      sim.statuses = [status]
      const result = await run()
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toMatch(words)
    }
  })

  it('waits through processing, then returns the outcome', async () => {
    sim.tx = executed({ SuccessValue: '' })
    sim.statuses = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS']
    await expect(run()).resolves.toMatchObject({ ok: true })
  })

  it('says it is still processing when the wait ends, inside 30 seconds', async () => {
    sim.tx = executed({ SuccessValue: '' })
    sim.statuses = ['PROCESSING']
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const startedAt = Date.now()
    const pending = submitOneClick(input())
    await vi.runAllTimersAsync()
    const result = await pending
    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/still processing.*Don't send it again/)
    expect(!result.ok && result.error).toContain(DEPOSIT)
  })

  it('does not claim a deposit landed when nothing has seen it', async () => {
    sim.tx = undefined
    sim.statuses = ['PENDING_DEPOSIT']
    const result = await run()
    expect(!result.ok && result.error).toMatch(/neither NEAR nor NEAR Intents has seen it/)
    expect(!result.ok && result.error).not.toMatch(/still processing/)
  })

  it('says still processing when NEAR confirms it but 1Click has not picked it up', async () => {
    sim.tx = executed({ SuccessValue: '' })
    sim.statuses = ['PENDING_DEPOSIT']
    const result = await run()
    expect(!result.ok && result.error).toMatch(/still processing/)
  })

  it('says still processing when only 1Click has seen it', async () => {
    sim.tx = undefined
    sim.statuses = ['KNOWN_DEPOSIT_TX']
    const result = await run()
    expect(!result.ok && result.error).toMatch(/still processing/)
  })

  it('keeps following the swap even when the RPC never sees the transaction', async () => {
    sim.tx = undefined
    sim.statuses = ['SUCCESS']
    await expect(run()).resolves.toMatchObject({ ok: true })
    expect(sim.submits).toHaveLength(0)
  })

  it('refuses a status for somebody else, a bad address and a bad hash', async () => {
    sim.tx = executed({ SuccessValue: '' })
    sim.statusRecipient = 'someone.near'
    expect(await run()).toMatchObject({ ok: false, error: expect.stringMatching(/different swap/) })

    expect(await run({ context: { depositAddress: 'evil.near' } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/deposit address was lost/),
    })
    expect(await run({ context: undefined })).toMatchObject({ ok: false })
    expect(await run({ signed: { family: 'near', hashes: ['../../etc'] } })).toMatchObject({
      ok: false,
    })
    expect(await run({ signed: { family: 'solana', signedTransaction: 'AA==' } })).toMatchObject({
      ok: false,
    })
  })

  it('never sends anything to the chain: only reads and 1Click notices', async () => {
    sim.tx = executed({ SuccessValue: '' })
    await run()
    const methods = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => init?.body as string | undefined)
      .filter((body) => body?.includes('jsonrpc'))
      .map((body) => (JSON.parse(body as string) as { method: string }).method)
    expect(methods.every((m) => m === 'tx' || m === 'query')).toBe(true)
  })
})
