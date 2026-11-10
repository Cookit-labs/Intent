import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  isAddress,
  isBlockhash,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit'
import { z } from 'zod'

import { bytesFromBase64 } from '../base64'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type VenueQuote,
} from '../types'
import { solanaAssertSafe } from './assert-safe'
import { venueFetch } from './http'
import { TITAN_SWAP_POLICY } from './programs'
import { readOnlyRpc, type SolanaRpc } from './stake-pool'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

/**
 * Titan's Portal: https://titan-exchange.gitbook.io/titan/developer-doc/developers-portal. One REST
 * call gives a routed quote with the instructions to run it, which this assembles into a transaction
 * for the wallet to sign. It lands through the Solana module's own submit, as Raydium does.
 */
export const TITAN_API = 'https://portal.api.titan.exchange'
const SLIPPAGE_BPS = 100
const MAX_VALUE_LOSS = 0.05
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
/** About 0.0001 SOL at the compute a route asks for, far under assert-safe's ceiling. */
const PRIORITY_MICRO_LAMPORTS = BigInt(50_000)
const FALLBACK_COMPUTE_UNITS = 400_000

/** A key Titan documents as `p`, which JSON may carry as text or as its 32 bytes. */
const Key = z.union([z.string(), z.array(z.number().int().min(0).max(255)).length(32)])

const RouteInstruction = z.object({
  p: Key,
  a: z.array(z.object({ p: Key, s: z.boolean(), w: z.boolean() })),
  d: z.string(),
})

const Route = z.object({
  inAmount: z.union([z.string(), z.number()]),
  outAmount: z.union([z.string(), z.number()]),
  slippageBps: z.number().int().nonnegative(),
  instructions: z.array(RouteInstruction).min(1),
  addressLookupTables: z.array(Key).optional(),
  computeUnitsSafe: z.number().int().positive().optional(),
})

const QuoteReply = z.object({
  inputMint: Key,
  outputMint: Key,
  amount: z.union([z.string(), z.number()]),
  quotes: z.record(Route),
  metadata: z
    .object({ ExpectedWinner: z.string().optional(), expectedWinner: z.string().optional() })
    .passthrough(),
  alts: z.array(z.object({ p: Key, a: z.array(Key) })).optional(),
})

const BlockhashReply = z.object({
  value: z.object({
    blockhash: z.string().refine(isBlockhash),
    lastValidBlockHeight: z.number().int().nonnegative(),
  }),
})

const decodeAddress = getAddressDecoder()

function keyText(key: z.infer<typeof Key>): string {
  return typeof key === 'string' ? key : decodeAddress.decode(Uint8Array.from(key))
}

function whole(value: string | number): string {
  const text = typeof value === 'number' ? BigInt(Math.trunc(value)).toString() : value
  if (!/^\d+$/.test(text)) throw new ChainActionRefused('Titan returned an amount I can’t read.')
  return text
}

function shortAmount(amount: string): string {
  const value = Number(amount)
  return value >= 1 ? String(Number(value.toFixed(4))) : String(Number(value.toPrecision(4)))
}

function roleOf(signer: boolean, writable: boolean): AccountRole {
  if (signer) return writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
  return writable ? AccountRole.WRITABLE : AccountRole.READONLY
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
}

function u64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & BigInt(0xff)))
}

const SET_LIMIT = 2
const SET_PRICE = 3

function budgetOf(tag: number, units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM as Address,
    accounts: [],
    data:
      tag === SET_LIMIT
        ? Uint8Array.from([SET_LIMIT, ...u32(units)])
        : Uint8Array.from([SET_PRICE, ...u64(PRIORITY_MICRO_LAMPORTS)]),
  }
}

/**
 * Titan's instructions as the kit reads them. Only the person may sign: Titan's quote is built for
 * their key, so a route naming any other signer is not one this app asked for.
 */
export function titanInstructions(route: z.infer<typeof Route>, account: string): Instruction[] {
  const instructions = route.instructions.map((raw): Instruction => {
    const accounts = raw.a.map((meta) => {
      const address = keyText(meta.p)
      if (meta.s && address !== account) {
        throw new ChainActionRefused(
          'Titan’s route asks for a signature from someone other than you, so I stopped here. Nothing was signed or sent.'
        )
      }
      return { address: address as Address, role: roleOf(meta.s, meta.w) }
    })
    return { programAddress: keyText(raw.p) as Address, accounts, data: bytesFromBase64(raw.d) }
  })
  // Titan's own budget asks for a bigger heap and the compute, and sets no price, which would leave
  // the swap at the back of the queue. Whatever it leaves out is added; nothing it set is changed.
  const set = new Set(
    instructions.filter((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM).map((i) => i.data?.[0])
  )
  const units = route.computeUnitsSafe ?? FALLBACK_COMPUTE_UNITS
  const missing = [SET_LIMIT, SET_PRICE]
    .filter((tag) => !set.has(tag))
    .map((tag) => budgetOf(tag, units))
  return [...missing, ...instructions]
}

export interface TitanSwapOptions {
  apiKey: string
  priceUsd: (token: ChainToken) => Promise<number | undefined>
  rpc?: SolanaRpc
  retryDelayMs?: number
}

export function createTitanSwapVenue(options: TitanSwapOptions): ChainVenue {
  const assertSafe = solanaAssertSafe(TITAN_SWAP_POLICY)
  const rpc = options.rpc ?? readOnlyRpc()
  const retry = options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}

  async function checkedQuote(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    if (request.kind !== 'swap') {
      throw new ChainActionRefused(`Titan swaps tokens. It can't ${request.kind} here.`)
    }
    const tokenIn = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    const tokenOut = tokenBySymbol(SOLANA_TOKENS, request.tokenOut ?? '')
    if (tokenIn === undefined || tokenOut === undefined || tokenIn.id === tokenOut.id) {
      throw new ChainActionRefused('I can only swap tokens I have confirmed on Solana.')
    }
    const amount = toBaseUnits(request.amount, tokenIn.decimals)
    const query = new URLSearchParams({
      inputMint: tokenIn.id,
      outputMint: tokenOut.id,
      amount,
      userPublicKey: account,
      slippageBps: String(SLIPPAGE_BPS),
      includeAltContents: 'true',
    })
    const { status, body } = await venueFetch(`${TITAN_API}/api/v1/quote/swap?${query}`, {
      label: 'Titan',
      headers: { 'x-api-key': options.apiKey, accept: 'application/json' },
      ...retry,
    })
    const parsed = QuoteReply.safeParse(body)
    if (status !== 200 || !parsed.success) {
      throw new ChainActionRefused(
        'Titan has no route for this swap right now. Nothing was signed or sent.'
      )
    }
    const reply = parsed.data
    const winner = reply.metadata.ExpectedWinner ?? reply.metadata.expectedWinner
    const route = winner === undefined ? undefined : reply.quotes[winner]
    if (route === undefined) {
      throw new ChainActionRefused(
        'Titan has no route for this swap right now. Nothing was signed or sent.'
      )
    }
    if (
      keyText(reply.inputMint) !== tokenIn.id ||
      keyText(reply.outputMint) !== tokenOut.id ||
      whole(reply.amount) !== amount ||
      whole(route.inAmount) !== amount
    ) {
      throw new ChainActionRefused(
        'Titan returned a quote that is not what you asked for, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (route.slippageBps > SLIPPAGE_BPS) {
      throw new ChainActionRefused(
        'This quote allows more slippage than the 1% I accept, so I stopped here. Nothing was signed or sent.'
      )
    }
    const outAmount = BigInt(whole(route.outAmount))
    const minimumBase = (outAmount * BigInt(10_000 - route.slippageBps)) / BigInt(10_000)
    const minimum = fromBaseUnits(minimumBase.toString(), tokenOut.decimals)
    const [priceIn, priceOut] = await Promise.all([
      options.priceUsd(tokenIn),
      options.priceUsd(tokenOut),
    ])
    if (priceIn === undefined || priceOut === undefined) {
      throw new ChainActionRefused(
        `I can't value both sides of this swap right now, so I can't check it's fair. Nothing was signed or sent, so try again in a moment.`
      )
    }
    const valueIn = Number(request.amount) * priceIn
    const valueOut = Number(minimum) * priceOut
    if (valueOut < valueIn * (1 - MAX_VALUE_LOSS)) {
      throw new ChainActionRefused(
        `At worst this swap returns about $${valueOut.toFixed(2)} of ${tokenOut.symbol} for $${valueIn.toFixed(2)} of ${tokenIn.symbol}, more than ${MAX_VALUE_LOSS * 100}% less than it is worth. That usually means thin liquidity, so I stopped here.`
      )
    }
    return { reply, route, tokenIn, tokenOut, outAmount, minimum }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { outAmount, tokenOut } = await checkedQuote(request, account)
    return {
      receive: {
        amount: fromBaseUnits(outAmount.toString(), tokenOut.decimals),
        symbol: tokenOut.symbol,
      },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const { reply, route, tokenIn, tokenOut, outAmount, minimum } = await checkedQuote(
      request,
      account
    )
    const instructions = titanInstructions(route, account)

    const wanted = new Set((route.addressLookupTables ?? []).map(keyText))
    const tables: Record<Address, Address[]> = {}
    for (const alt of reply.alts ?? []) {
      const table = keyText(alt.p)
      if (wanted.has(table)) tables[table as Address] = alt.a.map((k) => keyText(k) as Address)
    }
    if (Object.keys(tables).length !== wanted.size) {
      throw new ChainActionRefused(
        'Titan’s route is missing a lookup table it needs. Nothing was signed or sent.'
      )
    }

    const latest = BlockhashReply.safeParse(
      await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
    )
    if (!latest.success) {
      throw new ChainActionRefused(
        'Solana’s network could not be read just now. Nothing was signed or sent, so try again in a moment.'
      )
    }
    const { blockhash, lastValidBlockHeight } = latest.data.value
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(account as Address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) },
          m
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, tables)
    )
    const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
    // The same check the submit route runs, here so a route that would fail it never reaches a card.
    assertSafe({ family: 'solana', transaction }, account)

    const received = fromBaseUnits(outAmount.toString(), tokenOut.decimals)
    return {
      venueId: 'titan',
      venueName: 'Titan',
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${shortAmount(received)} ${tokenOut.symbol} through Titan.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: received, symbol: tokenOut.symbol, approximate: true },
      notes: [
        `The price can move before this lands. You get at least ${minimum} ${tokenOut.symbol} or the swap fails, and network fees still apply.`,
      ],
      signing: { family: 'solana', transaction },
    }
  }

  return { id: 'titan', name: 'Titan', kinds: ['swap'], quote, prepare, assertSafe }
}
