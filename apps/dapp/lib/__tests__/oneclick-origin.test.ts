import { createHmac } from 'node:crypto'

import { Inputs, Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearTokenCache } from '../chains/near/oneclick'
import { oneClickAssetId, oneClickOriginVenue } from '../chains/oneclick-origin'
import { afterSubmitting } from '../chains/signing-flow'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { SUI_TOKENS } from '../chains/sui/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type PreparedAction,
  type SubmitResult,
} from '../chains/types'

vi.mock('../chains/near/quote-signature', () => ({
  verifyQuoteSignature: vi.fn(() => true),
}))

// The real submit, without the minute of polling it would otherwise wait through.
vi.mock('../chains/solana/submit', async (original) => {
  const actual = await original<typeof import('../chains/solana/submit')>()
  return {
    ...actual,
    createSolanaSubmit: () => actual.createSolanaSubmit({ pollMs: 0, maxPolls: 1, env: {} }),
  }
})

const core = vi.hoisted(() => ({
  listCoins: vi.fn(),
  getBalance: vi.fn(),
  getObjects: vi.fn(),
  executeTransaction: vi.fn(),
  resolveTransactionPlugin: vi.fn(),
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({ core }),
}))

vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))

import { verifyQuoteSignature } from '../chains/near/quote-signature'

const token = (list: readonly ChainToken[], symbol: string): ChainToken =>
  tokenBySymbol(list, symbol) as ChainToken

const SOL_USDC = token(SOLANA_TOKENS, 'USDC')
const SOL_USDT = token(SOLANA_TOKENS, 'USDT')
const SOL_NATIVE = token(SOLANA_TOKENS, 'SOL')
const SUI_USDC = token(SUI_TOKENS, 'USDC')
const SUI_USDT = token(SUI_TOKENS, 'USDT')
const SUI_NATIVE = token(SUI_TOKENS, 'SUI')

const ME = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const DEPOSIT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const THIEF = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'
const UNITS = BigInt(25_000_000)

const SUI_ME = normalizeSuiAddress('0xa1')
const SUI_DEPOSIT = normalizeSuiAddress('0xd1')
const SUI_THIEF = normalizeSuiAddress('0xdead')
const COIN_A = normalizeSuiAddress('0xc1')
const GAS_COIN = normalizeSuiAddress('0xf1')
const DIGEST = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn'

type Json = Record<string, unknown>

function tokenList(): Json[] {
  const priceUpdatedAt = new Date().toISOString()
  const entry = (
    assetId: string,
    blockchain: string,
    symbol: string,
    decimals: number,
    price: number,
    contractAddress?: string
  ): Json => ({
    assetId,
    blockchain,
    symbol,
    decimals,
    price,
    priceUpdatedAt,
    ...(contractAddress !== undefined ? { contractAddress } : {}),
  })
  return [
    entry('nep141:sol-usdc.omft.near', 'sol', 'USDC', 6, 1, SOL_USDC.id),
    entry('nep141:sol-usdt.omft.near', 'sol', 'USDT', 6, 1, SOL_USDT.id),
    entry('nep141:sol.omft.near', 'sol', 'SOL', 9, 100),
    // A look-alike: the right symbol on the right chain, on another contract.
    entry('nep141:sol-fake.omft.near', 'sol', 'USDC', 6, 1, THIEF),
    entry('nep141:sui-usdc.omft.near', 'sui', 'USDC', 6, 1, SUI_USDC.id.replace('0xdba', '0xDBA')),
    entry('nep141:sui-usdt.omft.near', 'sui', 'USDT', 6, 1, SUI_USDT.id),
    entry('nep141:sui.omft.near', 'sui', 'SUI', 9, 2),
    entry('nep141:eth-usdc.omft.near', 'eth', 'USDC', 6, 1, SOL_USDC.id),
  ]
}

interface Sim {
  tokens: Json[]
  quotes: Json[]
  notified: Json[]
  rpc: string[]
  statuses: (string | undefined)[]
  statusRecipient: string | undefined
  quoteOverride: (body: Json) => Json | undefined
  send: () => unknown
  depositAddress: string
}

let sim: Sim

function goodQuote(body: Json): Json {
  const amount = body['amount'] as string
  // Priced to match the list: SOL at $100 and SUI at $2, against dollars with six places.
  const scale: Record<string, number> = {
    'nep141:sol.omft.near': 10,
    'nep141:sui.omft.near': 500,
  }
  const out = BigInt(amount) * BigInt(scale[body['destinationAsset'] as string] ?? 1)
  return {
    quote: {
      amountIn: amount,
      amountInFormatted: '25',
      amountInUsd: String(Number(amount) / 1e6),
      minAmountIn: amount,
      amountOut: out.toString(),
      amountOutFormatted: 'x',
      amountOutUsd: String((Number(amount) / 1e6) * 0.995),
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
        return json(sim.quoteOverride(body) ?? goodQuote(body), 201)
      }
      if (url.endsWith('/v0/deposit/submit')) {
        sim.notified.push(JSON.parse(init?.body as string) as Json)
        return json({ correlationId: 'c' })
      }
      if (url.includes('/v0/status')) {
        const status = sim.statuses.length > 1 ? sim.statuses.shift() : sim.statuses[0]
        return json({
          status,
          quoteResponse: { quoteRequest: { recipient: sim.statusRecipient } },
        })
      }
      const { method } = JSON.parse(init?.body as string) as { method: string }
      sim.rpc.push(method)
      const replies: Record<string, unknown> = {
        getAccountInfo: { result: { context: { slot: 1 }, value: null } },
        getLatestBlockhash: {
          result: {
            context: { slot: 1 },
            value: { blockhash: BLOCKHASH, lastValidBlockHeight: 9 },
          },
        },
        sendTransaction: method === 'sendTransaction' ? await sim.send() : undefined,
        getSignatureStatuses: {
          result: { value: [{ confirmationStatus: 'confirmed', err: null }] },
        },
        isBlockhashValid: { result: { value: true } },
      }
      return json({ jsonrpc: '2.0', id: 1, ...(replies[method] as object) })
    })
  )
}

const swap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'swap',
  amount: '25',
  tokenIn: 'USDC',
  tokenOut: 'SOL',
  ...over,
})

const suiSwap = (over: Partial<ChainActionRequest> = {}): ChainActionRequest =>
  swap({ tokenOut: 'SUI', ...over })

const solana = oneClickOriginVenue('solana')
const sui = oneClickOriginVenue('sui')

interface TransferFields {
  mint?: string
  to?: string
  amount?: bigint
  feePayer?: string
  extra?: boolean
  owner?: string
}

/** A signed-shaped Solana transaction with chosen fields, the way a tampered browser would. */
function solanaTx(fields: TransferFields = {}): string {
  const mint = fields.mint ?? SOL_USDC.id
  const to = fields.to ?? DEPOSIT
  const owner = fields.owner ?? ME
  const destination = associatedTokenAccount(to, mint)
  const transfer = (amount: bigint, target: string) => ({
    programAddress: TOKEN_PROGRAM as Address,
    accounts: [
      { address: associatedTokenAccount(owner, mint) as Address, role: AccountRole.WRITABLE },
      { address: mint as Address, role: AccountRole.READONLY },
      { address: target as Address, role: AccountRole.WRITABLE },
      { address: owner as Address, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([12, ...getU64Encoder().encode(amount), 6]),
  })
  const instructions = [
    {
      programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
      accounts: [
        { address: owner as Address, role: AccountRole.WRITABLE_SIGNER },
        { address: destination as Address, role: AccountRole.WRITABLE },
        { address: to as Address, role: AccountRole.READONLY },
        { address: mint as Address, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM as Address, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM as Address, role: AccountRole.READONLY },
      ],
      data: Uint8Array.of(1),
    },
    transfer(fields.amount ?? UNITS, destination),
    ...(fields.extra === true ? [transfer(BigInt(1), associatedTokenAccount(THIEF, mint))] : []),
  ]
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer((fields.feePayer ?? owner) as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: BigInt(9) },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions as never, m)
  )
  return getBase64EncodedWireTransaction(compileTransaction(message as never))
}

/** What a wallet hands back: the same bytes with the fee payer's signature filled in. */
function signedBytes(base64: string): string {
  const bytes = Buffer.from(base64, 'base64')
  bytes.fill(7, 1, 65)
  return bytes.toString('base64')
}

function suiTx(fields: { to?: string; amount?: bigint; gasOwner?: string; extra?: boolean } = {}) {
  const tx = new Transaction()
  tx.setSender(SUI_ME)
  tx.setGasOwner(fields.gasOwner ?? SUI_ME)
  tx.setGasPrice(1000)
  tx.setGasBudget(1_000_000)
  tx.setGasPayment([{ objectId: GAS_COIN, version: '10', digest: DIGEST }])
  const coin = tx.object(Inputs.ObjectRef({ objectId: COIN_A, version: '10', digest: DIGEST }))
  const [split] = tx.splitCoins(coin, [fields.amount ?? UNITS])
  tx.transferObjects([split as never], fields.to ?? SUI_DEPOSIT)
  if (fields.extra === true) {
    const [more] = tx.splitCoins(coin, [BigInt(1)])
    tx.transferObjects([more as never], SUI_THIEF)
  }
  return tx.build().then(toBase64)
}

function coinObject(objectId: string, type = SUI_USDC.id, owner = SUI_ME) {
  return {
    objectId,
    version: '10',
    digest: DIGEST,
    owner: { $kind: 'AddressOwner', AddressOwner: owner },
    type: `0x2::coin::Coin<${type}>`,
  }
}

beforeEach(() => {
  clearTokenCache()
  sim = {
    tokens: tokenList(),
    quotes: [],
    notified: [],
    rpc: [],
    statuses: ['SUCCESS'],
    statusRecipient: ME,
    quoteOverride: () => undefined,
    send: () => ({ result: 'sent' }),
    depositAddress: DEPOSIT,
  }
  installFetch()
  vi.stubEnv('AUTH_SECRET', 'x'.repeat(48))
  vi.mocked(verifyQuoteSignature).mockReturnValue(true)
  for (const mock of Object.values(core)) mock.mockReset()
  core.resolveTransactionPlugin.mockReturnValue(
    async (
      data: { gasData: { price: unknown; budget: unknown; payment: unknown } },
      _options: unknown,
      next: () => Promise<void>
    ) => {
      data.gasData.price = '1000'
      data.gasData.budget = '1000000'
      data.gasData.payment = [{ objectId: GAS_COIN, version: '10', digest: DIGEST }]
      await next()
    }
  )
  core.getObjects.mockImplementation(async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.map((id) => coinObject(id)),
  }))
  core.listCoins.mockImplementation(async ({ coinType }: { coinType: string }) => ({
    objects: [{ ...coinObject(COIN_A, coinType), balance: '90000000' }],
    hasNextPage: false,
    cursor: null,
  }))
  core.executeTransaction.mockResolvedValue({
    Transaction: { digest: 'DIGESTx', effects: { status: { success: true } } },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('oneClickAssetId', () => {
  it('matches on chain and contract', async () => {
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBe('nep141:sol-usdc.omft.near')
    await expect(oneClickAssetId('solana', SOL_USDT)).resolves.toBe('nep141:sol-usdt.omft.near')
  })

  it('refuses a look-alike symbol on another contract', async () => {
    const lookAlike = {
      symbol: 'USDC',
      id: 'So11111111111111111111111111111111111111113',
      decimals: 6,
    }
    await expect(oneClickAssetId('solana', lookAlike)).resolves.toBeUndefined()
  })

  it('refuses the right contract when the list has it only on another chain', async () => {
    sim.tokens = tokenList().filter((t) => t['blockchain'] !== 'sol')
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBeUndefined()
  })

  it('never folds case on a base58 mint, where case is the address', async () => {
    sim.tokens = [{ ...tokenList()[0], contractAddress: SOL_USDC.id.toLowerCase() }]
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBeUndefined()
  })

  it('reads hex in any case', async () => {
    await expect(oneClickAssetId('sui', SUI_USDC)).resolves.toBe('nep141:sui-usdc.omft.near')
  })

  it('refuses an entry whose decimals disagree with the token', async () => {
    sim.tokens = [{ ...tokenList()[0], decimals: 9 }]
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBeUndefined()
  })

  it('refuses a contract the list carries twice, since it could not say which is real', async () => {
    const first = tokenList()[0] as Json
    sim.tokens = [first, { ...first, assetId: 'nep141:other.omft.near' }]
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBeUndefined()
  })

  it('finds a native coin listed without a contract, but only the native coin', async () => {
    await expect(oneClickAssetId('solana', SOL_NATIVE)).resolves.toBe('nep141:sol.omft.near')
    await expect(oneClickAssetId('sui', SUI_NATIVE)).resolves.toBe('nep141:sui.omft.near')
    sim.tokens = [{ ...tokenList()[2], symbol: 'USDC', decimals: 6 }]
    clearTokenCache()
    await expect(oneClickAssetId('solana', SOL_USDC)).resolves.toBeUndefined()
  })

  it('finds a native coin listed under its contract too', async () => {
    sim.tokens = [{ ...tokenList()[2], contractAddress: SOL_NATIVE.id }]
    await expect(oneClickAssetId('solana', SOL_NATIVE)).resolves.toBe('nep141:sol.omft.near')
  })

  it('still reads a list whose contract is null, so NEAR prices never break on it', async () => {
    sim.tokens = [{ ...tokenList()[0] }, { ...tokenList()[2], contractAddress: null }]
    await expect(oneClickAssetId('solana', SOL_NATIVE)).resolves.toBe('nep141:sol.omft.near')
  })
})

describe('quote', () => {
  it('asks only for a dry quote and gives back what the swap would return', async () => {
    const quoted = await solana.quote?.(swap(), ME)
    expect(quoted).toEqual({
      receive: { amount: '0.25', symbol: 'SOL' },
      valueOutUsd: 24.875,
    })
    expect(sim.quotes).toHaveLength(1)
    expect(sim.quotes[0]).toMatchObject({
      dry: true,
      originAsset: 'nep141:sol-usdc.omft.near',
      destinationAsset: 'nep141:sol.omft.near',
      amount: '25000000',
      recipient: ME,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: ME,
      refundType: 'ORIGIN_CHAIN',
    })
    expect(JSON.stringify(quoted)).not.toContain(DEPOSIT)
  })

  it.each([
    ['solana', 'SOL', 'USDC', ME],
    ['sui', 'SUI', 'USDC', SUI_ME],
  ] as const)(
    'refuses native %s input in a plain sentence, before any quote',
    async (chain, tokenIn, tokenOut, account) => {
      const attempt = oneClickOriginVenue(chain).quote?.(swap({ tokenIn, tokenOut }), account)
      await expect(attempt).rejects.toBeInstanceOf(ChainActionRefused)
      await expect(attempt).rejects.toThrow(/USDC or USDT/)
      expect(sim.quotes).toHaveLength(0)
    }
  )

  it('refuses any other input, such as JitoSOL', async () => {
    await expect(
      solana.quote?.(swap({ tokenIn: 'JitoSOL', tokenOut: 'USDC' }), ME)
    ).rejects.toThrow(/USDC or USDT/)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses an output 1Click does not list, so the race drops the route', async () => {
    await expect(solana.quote?.(swap({ tokenOut: 'ONyc' }), ME)).rejects.toThrow(/ONyc/)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses USDT on Sui when 1Click does not list it', async () => {
    sim.tokens = tokenList().filter((t) => t['assetId'] !== 'nep141:sui-usdt.omft.near')
    await expect(sui.quote?.(suiSwap({ tokenIn: 'USDT' }), SUI_ME)).rejects.toBeInstanceOf(
      ChainActionRefused
    )
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses another chain’s account, and a swap to the same token', async () => {
    await expect(solana.quote?.(swap(), 'alice.near')).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(solana.quote?.(swap({ tokenOut: 'USDC' }), ME)).rejects.toThrow(/same token/)
  })

  it('offers no route when there is no secret to protect what it would issue', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    await expect(solana.quote?.(swap(), ME)).rejects.toBeInstanceOf(ChainActionRefused)
    expect(sim.quotes).toHaveLength(0)
  })

  it('refuses plainly on a chain whose deposits are not built yet', async () => {
    const avalanche = oneClickOriginVenue('avalanche')
    expect(avalanche.id).toBe('1click-avalanche')
    await expect(avalanche.quote?.(swap(), ME)).rejects.toBeInstanceOf(ChainActionRefused)
    await expect(avalanche.prepare(swap(), ME)).rejects.toBeInstanceOf(ChainActionRefused)
    expect(() => avalanche.assertSafe({ family: 'solana', transaction: 'AAAA' }, ME)).toThrow(
      ChainActionRefused
    )
  })
})

describe('prepare', () => {
  it('runs a dry quote and only then a real one, with a five-minute deadline', async () => {
    await solana.prepare(swap(), ME)
    expect(sim.quotes.map((q) => q['dry'])).toEqual([true, false])
    const minutes = (Date.parse(sim.quotes[1]?.['deadline'] as string) - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(3)
    expect(minutes).toBeLessThanOrEqual(5)
  })

  it('builds one transfer of exactly the quoted amount, which passes assertSafe', async () => {
    const prepared = await solana.prepare(swap(), ME)
    expect(prepared).toMatchObject({
      venueId: '1click-solana',
      kind: 'swap',
      pay: { amount: '25', symbol: 'USDC' },
      receive: { amount: '0.25', symbol: 'SOL', approximate: true },
    })
    expect(prepared.signing.family).toBe('solana')
    expect(prepared.context?.['depositAddress']).toBe(DEPOSIT)
    expect(() => solana.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
  })

  it('spends the token asked for, not USDC by assumption', async () => {
    const prepared = await solana.prepare(swap({ tokenIn: 'USDT' }), ME)
    expect(() => solana.assertSafe(prepared.signing, ME, prepared.context)).not.toThrow()
    if (prepared.signing.family !== 'solana') throw new Error('wrong family')
    const usdtTransfer = solanaTx({ mint: SOL_USDT.id })
    expect(() =>
      solana.assertSafe({ family: 'solana', transaction: usdtTransfer }, ME, prepared.context)
    ).not.toThrow()
    expect(() =>
      solana.assertSafe({ family: 'solana', transaction: solanaTx() }, ME, prepared.context)
    ).toThrow(ChainActionRefused)
  })

  it('refuses a deposit memo, and builds nothing', async () => {
    sim.quoteOverride = (body) => {
      if (body['dry'] === true) return undefined
      const good = goodQuote(body)
      return { ...good, quote: { ...(good['quote'] as Json), depositMemo: '12345' } }
    }
    await expect(solana.prepare(swap(), ME)).rejects.toThrow(/memo/i)
    expect(sim.rpc).toHaveLength(0)
  })

  it.each([
    ['an amount other than what was asked', { amountIn: '24000000' }],
    ['a smaller minimum in', { minAmountIn: '1' }],
    ['a minimum out past the slippage allowed', { minAmountOut: '1' }],
  ])('refuses a real quote with %s', async (_name, change) => {
    sim.quoteOverride = (body) => {
      if (body['dry'] === true) return undefined
      const good = goodQuote(body)
      return { ...good, quote: { ...(good['quote'] as Json), ...change } }
    }
    await expect(solana.prepare(swap(), ME)).rejects.toBeInstanceOf(ChainActionRefused)
    expect(sim.rpc).toHaveLength(0)
  })

  it.each([
    ['recipient', { recipient: THIEF }],
    ['refund address', { refundTo: THIEF }],
    ['refund type', { refundType: 'INTENTS' }],
  ])('refuses a real quote naming another %s', async (_name, change) => {
    sim.quoteOverride = (body) =>
      body['dry'] === true
        ? undefined
        : { ...goodQuote(body), quoteRequest: { ...body, ...change } }
    await expect(solana.prepare(swap(), ME)).rejects.toThrow(/didn't match/)
  })

  it('refuses a quote that fails its signature check', async () => {
    vi.mocked(verifyQuoteSignature).mockReturnValue(false)
    await expect(solana.prepare(swap(), ME)).rejects.toThrow(/signature/)
  })

  it('refuses a quote worth far less than it costs', async () => {
    sim.quoteOverride = (body) => {
      const good = goodQuote(body)
      return { ...good, quote: { ...(good['quote'] as Json), amountOutUsd: '1' } }
    }
    await expect(solana.prepare(swap(), ME)).rejects.toThrow(/less than you pay/)
  })

  it('refuses a deposit address that is your own wallet or not an address', async () => {
    sim.depositAddress = ME
    await expect(solana.prepare(swap(), ME)).rejects.toThrow(/your own wallet/)
    sim.depositAddress = 'not-an-address'
    await expect(solana.prepare(swap(), ME)).rejects.toBeInstanceOf(ChainActionRefused)
  })

  it('builds the Sui transfer from coins of the token asked for', async () => {
    sim.depositAddress = SUI_DEPOSIT
    sim.statusRecipient = SUI_ME
    const prepared = await sui.prepare(suiSwap({ tokenIn: 'USDT' }), SUI_ME)
    expect(core.listCoins.mock.calls[0]?.[0]).toMatchObject({ coinType: SUI_USDT.id })
    expect(prepared.venueId).toBe('1click-sui')
    expect(() => sui.assertSafe(prepared.signing, SUI_ME, prepared.context)).not.toThrow()
  })
})

describe('assertSafe on Solana', () => {
  let prepared: PreparedAction

  beforeEach(async () => {
    prepared = await solana.prepare(swap(), ME)
  })

  const check = (transaction: string, context = prepared.context, account = ME): void =>
    solana.assertSafe({ family: 'solana', transaction }, account, context)

  it('admits the one transfer that was issued', () => {
    expect(() => check(solanaTx())).not.toThrow()
  })

  it.each<[string, TransferFields]>([
    ['a wrong recipient', { to: THIEF }],
    ['a wrong amount', { amount: UNITS - BigInt(1) }],
    ['an extra transfer', { extra: true }],
    ['another token', { mint: SOL_USDT.id }],
    ['a fee payer other than the account', { feePayer: THIEF }],
  ])('refuses %s', (_name, fields) => {
    expect(() => check(solanaTx(fields))).toThrow(ChainActionRefused)
  })
})

describe('assertSafe on Sui', () => {
  let prepared: PreparedAction

  beforeEach(async () => {
    sim.depositAddress = SUI_DEPOSIT
    prepared = await sui.prepare(suiSwap(), SUI_ME)
  })

  const check = (transaction: string): void =>
    sui.assertSafe({ family: 'sui', transaction }, SUI_ME, prepared.context)

  it('admits the one transfer that was issued', async () => {
    const bytes = await suiTx()
    expect(() => check(bytes)).not.toThrow()
  })

  it.each([
    ['a wrong recipient', { to: SUI_THIEF }],
    ['a wrong amount', { amount: UNITS - BigInt(1) }],
    ['an extra transfer', { extra: true }],
    ['a gas owner other than the account', { gasOwner: SUI_THIEF }],
  ])('refuses %s', async (_name, fields) => {
    const bytes = await suiTx(fields)
    expect(() => check(bytes)).toThrow(ChainActionRefused)
  })
})

describe('a browser that changes what it sends back', () => {
  let prepared: PreparedAction

  beforeEach(async () => {
    prepared = await solana.prepare(swap(), ME)
  })

  const payload = (fields: TransferFields = {}) =>
    ({ family: 'solana', transaction: solanaTx(fields) }) as const

  it('cannot point the deposit at its own address', () => {
    const context = { ...prepared.context, depositAddress: THIEF }
    expect(() => solana.assertSafe(payload({ to: THIEF }), ME, context)).toThrow(ChainActionRefused)
  })

  it('cannot change the amount or the token with the bytes to match', () => {
    const smaller = { ...prepared.context, amount: '1' }
    expect(() => solana.assertSafe(payload({ amount: BigInt(1) }), ME, smaller)).toThrow(
      ChainActionRefused
    )
    const otherToken = { ...prepared.context, token: SOL_USDT.id }
    expect(() => solana.assertSafe(payload({ mint: SOL_USDT.id }), ME, otherToken)).toThrow(
      ChainActionRefused
    )
  })

  it('cannot extend the deadline', () => {
    const later = { ...prepared.context, deadline: '2099-01-01T00:00:00.000Z' }
    expect(() => solana.assertSafe(payload(), ME, later)).toThrow(ChainActionRefused)
  })

  it('cannot leave the context out or empty', () => {
    expect(() => solana.assertSafe(payload(), ME)).toThrow(ChainActionRefused)
    expect(() => solana.assertSafe(payload(), ME, {})).toThrow(ChainActionRefused)
  })

  it('cannot forge a proof without the server’s secret', () => {
    const context: Record<string, string> = { ...prepared.context, depositAddress: THIEF }
    const issued = JSON.stringify([
      '1click-solana',
      ME,
      SOL_USDC.id,
      '25000000',
      THIEF,
      context['deadline'],
    ])
    const proof = createHmac('sha256', 'y'.repeat(48)).update(issued).digest('base64url')
    expect(() => solana.assertSafe(payload({ to: THIEF }), ME, { ...context, proof })).toThrow(
      ChainActionRefused
    )
  })

  it('cannot reuse a proof for another account or another chain', async () => {
    // Bytes that are a perfect transfer from the other account, so only the proof can refuse them.
    expect(() => solana.assertSafe(payload({ owner: THIEF }), THIEF, prepared.context)).toThrow(
      /not what this app issued/
    )
    expect(() =>
      sui.assertSafe({ family: 'sui', transaction: 'AAAA' }, SUI_ME, prepared.context)
    ).toThrow(/not what this app issued/)
  })

  it('cannot spend a quote after its deadline', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * 60_000)
    expect(() => solana.assertSafe(payload(), ME, prepared.context)).toThrow(/expired/)
  })

  it('is refused when the server no longer holds the secret', () => {
    vi.stubEnv('AUTH_SECRET', '')
    expect(() => solana.assertSafe(payload(), ME, prepared.context)).toThrow(ChainActionRefused)
  })

  it('sends nothing from submit either', async () => {
    const context = { ...prepared.context, depositAddress: THIEF }
    const result = await solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'solana', signedTransaction: signedBytes(solanaTx({ to: THIEF })) },
      context,
    })
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(sim.rpc).not.toContain('sendTransaction')
  })

  it('is stopped by the real route, which hands assertSafe the context', async () => {
    const { POST } = await import('../../app/api/chain/[chain]/submit/route')
    const res = await POST(
      new Request('http://localhost/api/chain/solana/submit', {
        method: 'POST',
        body: JSON.stringify({
          account: ME,
          venueId: '1click-solana',
          signed: { family: 'solana', signedTransaction: signedBytes(solanaTx({ to: THIEF })) },
          context: { ...prepared.context, depositAddress: THIEF },
        }),
      }),
      { params: Promise.resolve({ chain: 'solana' }) }
    )
    expect(res.status).toBe(422)
    expect(sim.rpc).not.toContain('sendTransaction')
  })
})

describe('the submit route', () => {
  it('gives a submit the 60 seconds it waits within', async () => {
    const route = await import('../../app/api/chain/[chain]/submit/route')
    expect(route.maxDuration).toBe(60)
  })

  it('hands assertSafe the context, so an honest swap gets through', async () => {
    const prepared = await solana.prepare(swap(), ME)
    const { POST } = await import('../../app/api/chain/[chain]/submit/route')
    const res = await POST(
      new Request('http://localhost/api/chain/solana/submit', {
        method: 'POST',
        body: JSON.stringify({
          account: ME,
          venueId: '1click-solana',
          signed: { family: 'solana', signedTransaction: signedBytes(solanaTx()) },
          context: prepared.context,
        }),
      }),
      { params: Promise.resolve({ chain: 'solana' }) }
    )
    expect(res.status).toBe(200)
    expect(sim.rpc).toContain('sendTransaction')
  })
})

describe('submit on Solana', () => {
  let prepared: PreparedAction

  beforeEach(async () => {
    prepared = await solana.prepare(swap(), ME)
  })

  async function run(fields: TransferFields = {}): Promise<SubmitResult> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'solana', signedTransaction: signedBytes(solanaTx(fields)) },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    }) as Promise<SubmitResult>
    await vi.runAllTimersAsync()
    return pending
  }

  it('returns ok once 1Click reports success, and tells it about the deposit', async () => {
    const result = await run()
    expect(result).toMatchObject({ ok: true })
    expect(sim.rpc).toContain('sendTransaction')
    expect(sim.notified).toHaveLength(1)
    expect(sim.notified[0]).toMatchObject({ depositAddress: DEPOSIT })
    expect(sim.notified[0]).not.toHaveProperty('nearSenderAccount')
  })

  it('keeps following while the swap runs', async () => {
    sim.statuses = ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']
    await expect(run()).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['a swap still running', 'PROCESSING', /still processing/i],
    ['a swap not seen yet', 'PENDING_DEPOSIT', /still processing/i],
    ['a refund', 'REFUNDED', new RegExp(ME)],
    ['a failed swap', 'FAILED', new RegExp(ME)],
    ['too little received', 'INCOMPLETE_DEPOSIT', new RegExp(ME)],
    ['an unknown status', 'SOMETHING_NEW', /still processing/i],
  ])('reports %s as pending, holding the latch', async (_name, status, sentence) => {
    sim.statuses = [status]
    const result = await run()
    expect(result).toMatchObject({ ok: false, pending: true })
    if (result.ok) return
    expect(result.error).toMatch(sentence)
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
  })

  it('reports a deposit address 1Click ties to someone else as pending', async () => {
    sim.statusRecipient = THIEF
    await expect(run()).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('stops following within the route’s 60 seconds', async () => {
    sim.statuses = ['PROCESSING']
    const startedAt = Date.now()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: startedAt })
    const pending = solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'solana', signedTransaction: signedBytes(solanaTx()) },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    }) as Promise<SubmitResult>
    await vi.runAllTimersAsync()
    await pending
    expect(Date.now() - startedAt).toBeLessThan(60_000)
  })

  it('answers pending if the network has not answered by the time limit', async () => {
    sim.send = () => new Promise(() => undefined)
    const startedAt = Date.now()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: startedAt })
    const pending = solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'solana', signedTransaction: signedBytes(solanaTx()) },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    }) as Promise<SubmitResult>
    await vi.advanceTimersByTimeAsync(55_000)
    const result = await pending
    expect(result).toMatchObject({ ok: false, pending: true })
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
    expect(sim.notified).toHaveLength(0)
  })

  it('passes on a clean failure the network proved, without asking 1Click', async () => {
    sim.send = () => ({ error: { code: -32002, message: 'simulation failed', data: {} } })
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'failed', latched: false })
    expect(sim.notified).toHaveLength(0)
  })

  it('reports an unclear send answer as pending, without asking 1Click', async () => {
    sim.send = () => ({ error: { code: -32000, message: 'gateway said something' } })
    const result = await run()
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).toContain(DEPOSIT)
    expect(sim.notified).toHaveLength(0)
  })

  it('reports a dropped connection during the send as pending', async () => {
    sim.send = () => {
      throw new Error('connection reset')
    }
    await expect(run()).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('sends nothing the wallet left unsigned', async () => {
    const result = await solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'solana', signedTransaction: solanaTx() },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(sim.rpc).not.toContain('sendTransaction')
  })

  it('refuses another chain’s signature without sending', async () => {
    const result = await solana.submit?.({
      account: ME,
      venueId: solana.id,
      signed: { family: 'sui', transaction: 'AAAA', signature: 'sig' },
    })
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })
})

describe('submit on Sui', () => {
  let prepared: PreparedAction

  beforeEach(async () => {
    sim.depositAddress = SUI_DEPOSIT
    sim.statusRecipient = SUI_ME
    prepared = await sui.prepare(suiSwap(), SUI_ME)
  })

  async function run(): Promise<SubmitResult> {
    const transaction = await suiTx()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = sui.submit?.({
      account: SUI_ME,
      venueId: sui.id,
      signed: { family: 'sui', transaction, signature: 'sig' },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    }) as Promise<SubmitResult>
    await vi.runAllTimersAsync()
    return pending
  }

  it('returns ok on success, with the Sui explorer link', async () => {
    const result = await run()
    expect(result).toEqual({
      ok: true,
      hash: 'DIGESTx',
      explorerUrl: 'https://suiscan.xyz/mainnet/tx/DIGESTx',
    })
    expect(sim.notified[0]).toMatchObject({ txHash: 'DIGESTx', depositAddress: SUI_DEPOSIT })
  })

  it('refuses a coin of another type, which the bytes cannot show, without sending', async () => {
    core.getObjects.mockResolvedValue({ objects: [coinObject(COIN_A, SUI_USDT.id)] })
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(afterSubmitting(result, 'sui')).toMatchObject({ phase: 'failed', latched: false })
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('passes on a failure the network proved, in the words of the token', async () => {
    core.executeTransaction.mockResolvedValue({
      FailedTransaction: { digest: 'DIGESTx', effects: { status: { success: false } } },
    })
    const result = await run()
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    if (!result.ok) expect(result.error).toMatch(/USDC did not move/)
    expect(sim.notified).toHaveLength(0)
  })

  it('reports a broken connection during the send as pending', async () => {
    core.executeTransaction.mockRejectedValue(new Error('deadline exceeded'))
    const result = await run()
    expect(result).toMatchObject({ ok: false, pending: true })
    expect(afterSubmitting(result, 'sui')).toMatchObject({ phase: 'pending', latched: true })
  })

  it.each(['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'])(
    'reports %s after the transfer as pending, naming where funds return',
    async (status) => {
      sim.statuses = [status]
      const result = await run()
      expect(result).toMatchObject({ ok: false, pending: true })
      if (!result.ok) expect(result.error).toContain(SUI_ME)
    }
  )
})
