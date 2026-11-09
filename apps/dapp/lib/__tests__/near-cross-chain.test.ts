import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { crossChainVenue, CROSS_CHAIN_VENUE_ID } from '../chains/near/cross-chain'
import { nearModule } from '../chains/near/module'
import { clearTokenCache } from '../chains/near/oneclick'
import { USDC_NEAR } from '../chains/near/tokens'
import { parseChainAction } from '../chains/parse-action'
import { prepareChainAction } from '../chains/prepare'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { SUI_TOKENS } from '../chains/sui/tokens'
import { ChainActionRefused, type ChainActionRequest, type NearFunctionCall } from '../chains/types'

vi.mock('../chains/near/quote-signature', () => ({ verifyQuoteSignature: vi.fn(() => true) }))

// The module decides at load whether this deployment can offer sends at all.
vi.hoisted(() => {
  process.env['AUTH_SECRET'] = 'a'.repeat(40)
})

const ME = 'alice.near'
const DEPOSIT = 'dc2c3034e3ebefa1af9a2c419f896d7b761a056244099eefcd09aeb7efc1b86d'
const HASH = 'G6RQqbkHNF1JVMwmq9BiLnZ3vvUeYoNm7z4dYVEKgScA'
const ON_SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const ON_SUI = `0x${'ab'.repeat(32)}`
const USDC_SOLANA = SOLANA_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const USDC_SUI = SUI_TOKENS.find((t) => t.symbol === 'USDC')?.id as string
const SOLANA_ASSET = 'nep141:sol-usdc.omft.near'
const SUI_ASSET = 'nep141:sui-usdc.omft.near'

type Json = Record<string, unknown>

interface Sim {
  solanaAccount: Json | null | undefined
  quotes: Json[]
  status: string
  statusRecipient: string
  listed: Json[]
}

const priced = { price: 1, priceUpdatedAt: new Date().toISOString() }

function tokenList(): Json[] {
  return [
    { assetId: `nep141:${USDC_NEAR}`, decimals: 6, symbol: 'USDC', blockchain: 'near', ...priced },
    {
      assetId: 'nep141:usdt.tether-token.near',
      decimals: 6,
      symbol: 'USDT',
      blockchain: 'near',
      ...priced,
    },
    {
      assetId: SOLANA_ASSET,
      decimals: 6,
      symbol: 'USDC',
      blockchain: 'sol',
      contractAddress: USDC_SOLANA,
      ...priced,
    },
    {
      assetId: SUI_ASSET,
      decimals: 6,
      symbol: 'USDC',
      blockchain: 'sui',
      contractAddress: USDC_SUI,
      ...priced,
    },
  ]
}

function quoteFor(body: Json): Json {
  const amount = body['amount'] as string
  const out = (BigInt(amount) * BigInt(995)) / BigInt(1000)
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: '5',
      amountInUsd: String(Number(amount) / 1e6),
      minAmountIn: amount,
      amountOut: out.toString(),
      amountOutFormatted: '4.975',
      amountOutUsd: String(Number(out) / 1e6),
      minAmountOut: ((out * BigInt(99)) / BigInt(100)).toString(),
      timeEstimate: 20,
      refundFee: '0',
      withdrawFee: '0',
      ...(body['dry'] === true
        ? {}
        : {
            depositAddress: DEPOSIT,
            deadline: '2026-11-20T00:00:00.000Z',
            timeWhenInactive: '2026-11-20T00:00:00.000Z',
          }),
    },
    quoteRequest: body,
    signature: 'ed25519:x',
    timestamp: '2026-11-09T00:00:00.000Z',
  }
}

function install(sim: Sim, quoteAnswer: (body: Json) => Json = quoteFor): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (data: unknown, status = 200): Response =>
        new Response(JSON.stringify(data), { status })
      if (url.endsWith('/v0/tokens')) return json(sim.listed)
      if (url.endsWith('/v0/quote')) {
        const body = JSON.parse(init?.body as string) as Json
        sim.quotes.push(body)
        return json(quoteAnswer(body), 201)
      }
      if (url.endsWith('/v0/deposit/submit')) return json({ correlationId: 'c' })
      if (url.includes('/v0/status')) {
        return json({
          status: sim.status,
          quoteResponse: { quoteRequest: { recipient: sim.statusRecipient } },
        })
      }
      if (url.includes('api.fastnear.com')) return json({ tokens: [] })
      if (url.includes('solana')) {
        return sim.solanaAccount === undefined
          ? json({})
          : json({ result: { value: sim.solanaAccount } })
      }
      const rpc = JSON.parse(init?.body as string) as {
        method: string
        params: { request_type?: string; method_name?: string }
      }
      if (rpc.method === 'tx') {
        return json({
          result: {
            status: { SuccessValue: '' },
            transaction: {
              signer_id: ME,
              receiver_id: USDC_NEAR,
              actions: [
                {
                  FunctionCall: {
                    method_name: 'ft_transfer',
                    args: Buffer.from(
                      JSON.stringify({ receiver_id: DEPOSIT, amount: '5000000' })
                    ).toString('base64'),
                    deposit: '1',
                  },
                },
              ],
            },
          },
        })
      }
      if (rpc.params.request_type === 'view_account') {
        return json({ result: { amount: '1000000000000000000000000' } })
      }
      const answer = rpc.params.method_name === 'ft_balance_of' ? '100000000' : { total: '1' }
      return json({ result: { result: [...Buffer.from(JSON.stringify(answer))] } })
    })
  )
}

const send = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'send',
  amount: '5',
  tokenIn: 'USDC',
  recipient: ON_SOLANA,
  ...over,
})

let sim: Sim

beforeEach(() => {
  clearTokenCache()
  sim = {
    solanaAccount: null,
    quotes: [],
    status: 'SUCCESS',
    statusRecipient: ON_SOLANA,
    listed: tokenList(),
  }
  install(sim)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('reading a cross-chain send from chat', () => {
  it('keeps the address exactly as typed, since base58 is case sensitive', () => {
    expect(parseChainAction(`send 5 USDC to ${ON_SOLANA}`)).toMatchObject({
      kind: 'send',
      tokenIn: 'USDC',
      recipient: ON_SOLANA,
    })
  })
})

describe('preparing a send from NEAR to another chain', () => {
  it('pays out on Solana, previewing first, and asks for the money back here if it fails', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)

    expect(sim.quotes.map((q) => q['dry'])).toEqual([true, false])
    for (const quote of sim.quotes) {
      expect(quote).toMatchObject({
        originAsset: `nep141:${USDC_NEAR}`,
        destinationAsset: SOLANA_ASSET,
        recipient: ON_SOLANA,
        recipientType: 'DESTINATION_CHAIN',
        refundTo: ME,
        refundType: 'ORIGIN_CHAIN',
        depositType: 'ORIGIN_CHAIN',
      })
    }
    expect(prepared.venueId).toBe(CROSS_CHAIN_VENUE_ID)
    expect(prepared.kind).toBe('send')
    expect(prepared.summary).toBe(`Send 5 USDC from NEAR to ${ON_SOLANA} on Solana.`)
    expect(prepared.pay).toEqual({ amount: '5', symbol: 'USDC' })
    expect(prepared.receive).toMatchObject({ amount: '4.975', symbol: 'USDC' })
    expect(prepared.notes.join(' ')).toMatch(/can't be undone/)
    expect(prepared.notes.join(' ')).toContain('refund')
  })

  it('pays out on Sui by the same path', async () => {
    const prepared = await prepareChainAction(nearModule, send({ recipient: ON_SUI }), ME)
    expect(sim.quotes[0]).toMatchObject({ destinationAsset: SUI_ASSET, recipient: ON_SUI })
    expect(prepared.summary).toBe(`Send 5 USDC from NEAR to ${ON_SUI} on Sui.`)
  })

  it('builds only a deposit of USDC to the quote’s address', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)
    if (prepared.signing.family !== 'near') throw new Error('wrong family')
    const transaction = prepared.signing.transactions[0]
    const last = transaction?.actions.at(-1) as NearFunctionCall
    expect(transaction?.receiverId).toBe(USDC_NEAR)
    expect(last.params.methodName).toBe('ft_transfer')
    expect(last.params.args).toEqual({ receiver_id: DEPOSIT, amount: '5000000' })
    expect(() => crossChainVenue.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('refuses a quote that pays someone other than the address that was typed', async () => {
    install(sim, (body) => quoteFor({ ...body, recipient: 'someone-else' }))
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(/didn't match/)
  })

  it('refuses a quote that would refund someone else', async () => {
    install(sim, (body) => quoteFor({ ...body, refundTo: 'mallory.near' }))
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(/didn't match/)
  })

  it('refuses every token but USDC, because only it is the same money on both sides', async () => {
    await expect(prepareChainAction(nearModule, send({ tokenIn: 'USDT' }), ME)).rejects.toThrow(
      /USDC/
    )
    await expect(prepareChainAction(nearModule, send({ tokenIn: 'NEAR' }), ME)).rejects.toThrow(
      /USDC/
    )
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses when 1Click does not list USDC on that chain, rather than guess an asset', async () => {
    sim.listed = tokenList().filter((t) => t['blockchain'] !== 'sol')
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(ChainActionRefused)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses a token contract as the recipient', async () => {
    await expect(
      prepareChainAction(nearModule, send({ recipient: USDC_SOLANA }), ME)
    ).rejects.toThrow(ChainActionRefused)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses more than the wallet holds, before asking for a quote', async () => {
    await expect(prepareChainAction(nearModule, send({ amount: '500' }), ME)).rejects.toThrow(
      /You hold/
    )
    expect(sim.quotes).toHaveLength(0)
  })

  it('leaves an address on NEAR to the plain send', async () => {
    vi.stubEnv('AUTH_SECRET', 'a'.repeat(40))
    const { buildNearVenues } = await import('../chains/near/module')
    const prepared = await prepareChainAction(
      { ...nearModule, venues: buildNearVenues(process.env) },
      send({ recipient: 'bob.near' }),
      ME
    )
    expect(prepared.venueId).toBe('send')
    expect(sim.quotes).toHaveLength(0)
  })

  it('still refuses an address that belongs to no chain it can reach', async () => {
    await expect(
      prepareChainAction(nearModule, send({ recipient: '0x' + 'a'.repeat(40) }), ME)
    ).rejects.toThrow(/can receive on NEAR/)
    expect(sim.quotes).toHaveLength(0)
  })
})

describe('following a send to another chain', () => {
  const submit = async (context: Record<string, string> | undefined) =>
    crossChainVenue.submit?.({
      account: ME,
      venueId: CROSS_CHAIN_VENUE_ID,
      signed: { family: 'near', hashes: [HASH] },
      ...(context !== undefined ? { context } : {}),
    })

  it('confirms when NEAR Intents says it landed with the person it was for', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: true, hash: HASH })
  })

  it('never confirms a deposit address that belongs to another payment', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)
    sim.statusRecipient = 'someone-else'
    await expect(submit(prepared.context)).resolves.toMatchObject({
      ok: false,
      pending: true,
      error: expect.stringContaining('different') as string,
    })
  })

  it('says the money came back when NEAR Intents refunds it', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)
    sim.status = 'REFUNDED'
    await expect(submit(prepared.context)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(ME) as string,
    })
  })
})

describe('a plain 1Click swap', () => {
  it('still pays only the person swapping, with no recipient to choose', async () => {
    const { oneClickVenue } = await import('../chains/near/swap')
    sim.statusRecipient = ME
    await oneClickVenue.prepare(
      { kind: 'swap', amount: '5', tokenIn: 'USDC', tokenOut: 'USDT' },
      ME
    )
    expect(sim.quotes[0]).toMatchObject({ recipient: ME, refundTo: ME })
  })
})

describe('a Solana address that can’t hold what is sent', () => {
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

  it('refuses a token account, which pays nobody it can be got back from', async () => {
    sim.solanaAccount = { owner: TOKEN_PROGRAM, executable: false }
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(/token account/)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses a program, in words about a transfer', async () => {
    sim.solanaAccount = { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true }
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(/program/)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses when Solana can’t be read, rather than guess', async () => {
    sim.solanaAccount = undefined
    await expect(prepareChainAction(nearModule, send(), ME)).rejects.toThrow(/could not be read/)
    expect(sim.quotes).toHaveLength(0)
  })

  it('takes a wallet with no account yet', async () => {
    await expect(prepareChainAction(nearModule, send(), ME)).resolves.toMatchObject({
      kind: 'send',
    })
  })
})

describe('the words on a send to another chain', () => {
  const withFee = (body: Json): Json => {
    const answer = quoteFor(body) as { quote: Json }
    return { ...answer, quote: { ...answer.quote, withdrawFee: '10006', refundFee: '10005' } }
  }

  it('describes a transfer, and never registers anyone on a token', async () => {
    install(sim, withFee)
    const prepared = await prepareChainAction(nearModule, send(), ME)
    const notes = prepared.notes.join(' ')
    expect(notes).not.toMatch(/register you/)
    expect(notes).not.toMatch(/\bswap/i)
    expect(notes).toContain('0.010006 USDC for the payout on Solana')
  })

  it('says a refund is a transfer that did not go through', async () => {
    const prepared = await prepareChainAction(nearModule, send(), ME)
    sim.status = 'REFUNDED'
    const result = await crossChainVenue.submit?.({
      account: ME,
      venueId: CROSS_CHAIN_VENUE_ID,
      signed: { family: 'near', hashes: [HASH] },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })
    expect(result).toMatchObject({ ok: false })
    if (result?.ok === false) {
      expect(result.error).toMatch(/This transfer did not go through/)
      expect(result.error).not.toMatch(/\bswap/i)
    }
  })

  it('says what it reaches when named for a NEAR account', async () => {
    await expect(crossChainVenue.prepare(send({ recipient: 'bob.near' }), ME)).rejects.toThrow(
      /Solana or Sui/
    )
  })
})
