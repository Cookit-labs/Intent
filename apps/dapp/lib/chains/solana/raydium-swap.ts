import { isAddress } from '@solana/kit'
import { z } from 'zod'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import {
  associatedTokenAccount,
  decodeSolanaTransaction,
  readLittleEndian,
  solanaAssertSafe,
} from './assert-safe'
import { venueFetch } from './http'
import { RAYDIUM_ROUTE_PROGRAM, RAYDIUM_SWAP_POLICY } from './programs'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

/** Raydium's Trade API: https://docs.raydium.io/sdk-api/trade-api. No key. */
const RAYDIUM_API = 'https://transaction-v1.raydium.io'
const SLIPPAGE_BPS = 100
const MAX_PRICE_IMPACT_PERCENT = 3
const MAX_VALUE_LOSS = 0.05
/** About 10,000 lamports at the compute Raydium asks for, far under assert-safe's ceiling. */
const PRIORITY_MICRO_LAMPORTS = '50000'
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'

/**
 * Raydium's route instructions, by their first byte, as its Trade API built them for SOL to USDC,
 * USDC to SOL and USDC to USDT on 6 November 2026: a swap with the amount in and the least out, a
 * wrap of the SOL spent, and a closing step with no data. Nothing else is expected.
 */
const SWAP_BASE_IN = 0
const WRAP_SOL = 5
const CLOSE = 6

const Quote = z.object({
  success: z.literal(true),
  data: z.object({
    swapType: z.literal('BaseIn'),
    inputMint: z.string(),
    outputMint: z.string(),
    inputAmount: z.string().regex(/^\d+$/),
    outputAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    slippageBps: z.number(),
    priceImpactPct: z.number(),
    routePlan: z.array(z.object({ poolId: z.string() })).min(1),
  }),
})

const Built = z.object({
  success: z.literal(true),
  data: z.array(z.object({ transaction: z.string().min(1) })),
})

function refuse(sentence: string): never {
  throw new ChainActionRefused(
    `${sentence} I refused it, so nothing was signed or sent. Try again, or use another venue if it keeps happening.`
  )
}

/** What a Raydium transaction must do: spend this much, accept no less than this, and wrap only it. */
export interface RaydiumExpectation {
  amountIn: bigint
  minimumOut: bigint
  wrapsSol: boolean
}

/**
 * Holds each Raydium route instruction to what was asked: one swap of exactly the amount, for no
 * less than the quote's floor, a SOL wrap of that same amount only when SOL is spent, and at most
 * one closing step. Any other route instruction is refused, since its meaning can't be read.
 */
export function assertRaydiumRoute(base64: string, expected: RaydiumExpectation): void {
  const transaction = decodeSolanaTransaction(base64)
  let swaps = 0
  let wraps = 0
  let closes = 0
  for (const instruction of transaction.instructions) {
    if (transaction.staticAccounts[instruction.programIndex] !== RAYDIUM_ROUTE_PROGRAM) continue
    const { data } = instruction
    const tag = data[0]
    if (tag === SWAP_BASE_IN && data.length === 17) {
      swaps += 1
      if (readLittleEndian(data, 1, 8) !== expected.amountIn) {
        refuse('This Raydium swap spends a different amount from the one you asked.')
      }
      if (readLittleEndian(data, 9, 8) !== expected.minimumOut) {
        refuse('This Raydium swap accepts less than the quote it was built from.')
      }
    } else if (tag === WRAP_SOL && data.length === 9) {
      wraps += 1
      if (!expected.wrapsSol || readLittleEndian(data, 1, 8) !== expected.amountIn) {
        refuse('This Raydium swap would wrap SOL you did not ask to spend.')
      }
    } else if (tag === CLOSE && data.length === 1) {
      closes += 1
    } else {
      refuse('This transaction asks Raydium for an instruction I didn’t expect.')
    }
  }
  if (swaps !== 1 || wraps > 1 || closes > 1) {
    refuse('This transaction is not the one Raydium swap that was quoted.')
  }
}

function expectationOf(context: Record<string, string> | undefined): RaydiumExpectation {
  const amountIn = context?.['amountIn']
  const minimumOut = context?.['minimumOut']
  if (
    amountIn === undefined ||
    minimumOut === undefined ||
    !/^\d+$/.test(amountIn) ||
    !/^\d+$/.test(minimumOut)
  ) {
    return refuse('This swap lost track of its quote.')
  }
  return {
    amountIn: BigInt(amountIn),
    minimumOut: BigInt(minimumOut),
    wrapsSol: context?.['wrapsSol'] === '1',
  }
}

function shortAmount(amount: string): string {
  const value = Number(amount)
  return value >= 1 ? String(Number(value.toFixed(4))) : String(Number(value.toPrecision(4)))
}

export interface RaydiumSwapOptions {
  priceUsd: (token: ChainToken) => Promise<number | undefined>
  retryDelayMs?: number
}

/**
 * Raydium's Trade API: a quote, then a transaction built from it for the wallet to sign. It lands
 * through the Solana module's own submit, since Raydium has no endpoint that sends.
 */
export function createRaydiumSwapVenue(options: RaydiumSwapOptions): ChainVenue {
  const programsSafe = solanaAssertSafe(RAYDIUM_SWAP_POLICY)
  const retry = options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}

  async function checkedQuote(request: ChainActionRequest, account: string) {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    if (request.kind !== 'swap') {
      throw new ChainActionRefused(`Raydium swaps tokens. It can't ${request.kind} here.`)
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
      slippageBps: String(SLIPPAGE_BPS),
      txVersion: 'V0',
    })
    const { status, body } = await venueFetch(`${RAYDIUM_API}/compute/swap-base-in?${query}`, {
      label: 'Raydium',
      ...retry,
    })
    const parsed = Quote.safeParse(body)
    if (status !== 200 || !parsed.success) {
      throw new ChainActionRefused(
        'Raydium has no route for this swap right now. Nothing was signed or sent.'
      )
    }
    const quote = parsed.data.data
    if (
      quote.inputMint !== tokenIn.id ||
      quote.outputMint !== tokenOut.id ||
      quote.inputAmount !== amount
    ) {
      throw new ChainActionRefused(
        'Raydium returned a quote that is not what you asked for, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (quote.slippageBps > SLIPPAGE_BPS) {
      throw new ChainActionRefused(
        'This quote allows more slippage than the 1% I accept, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (Math.abs(quote.priceImpactPct) > MAX_PRICE_IMPACT_PERCENT) {
      throw new ChainActionRefused(
        `This swap has a price impact of about ${Math.abs(quote.priceImpactPct).toFixed(1)}% on Raydium, above the ${MAX_PRICE_IMPACT_PERCENT}% I accept. Try a smaller amount.`
      )
    }
    const minimum = fromBaseUnits(quote.otherAmountThreshold, tokenOut.decimals)
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
    // Sent back whole: the build reads route fields this check has no need of, and parsing drops them.
    return { raw: body, quote, tokenIn, tokenOut, amount, minimum }
  }

  async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
    const { quote: q, tokenOut } = await checkedQuote(request, account)
    return {
      receive: {
        amount: fromBaseUnits(q.outputAmount, tokenOut.decimals),
        symbol: tokenOut.symbol,
      },
    }
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const {
      raw,
      quote: q,
      tokenIn,
      tokenOut,
      amount,
      minimum,
    } = await checkedQuote(request, account)
    const wrapsSol = tokenIn.id === WRAPPED_SOL
    const { status, body } = await venueFetch(`${RAYDIUM_API}/transaction/swap-base-in`, {
      label: 'Raydium',
      method: 'POST',
      body: {
        computeUnitPriceMicroLamports: PRIORITY_MICRO_LAMPORTS,
        swapResponse: raw,
        txVersion: 'V0',
        wallet: account,
        wrapSol: wrapsSol,
        unwrapSol: tokenOut.id === WRAPPED_SOL,
        ...(wrapsSol ? {} : { inputAccount: associatedTokenAccount(account, tokenIn.id) }),
      },
      ...retry,
    })
    const built = Built.safeParse(body)
    if (status !== 200 || !built.success || built.data.data.length !== 1) {
      throw new ChainActionRefused(
        'Raydium could not build this swap. Nothing was signed or sent. Check that you hold the token and a little SOL for fees, then try again.'
      )
    }
    const transaction = (built.data.data[0] as { transaction: string }).transaction
    const expected = {
      amountIn: BigInt(amount),
      minimumOut: BigInt(q.otherAmountThreshold),
      wrapsSol,
    }
    assertRaydiumRoute(transaction, expected)

    const received = fromBaseUnits(q.outputAmount, tokenOut.decimals)
    return {
      venueId: 'raydium',
      venueName: 'Raydium',
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${shortAmount(received)} ${tokenOut.symbol} through Raydium.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: received, symbol: tokenOut.symbol, approximate: true },
      notes: [
        `The price can move before this lands. You get at least ${minimum} ${tokenOut.symbol} or the swap fails, and network fees still apply.`,
      ],
      signing: { family: 'solana', transaction },
      context: {
        amountIn: amount,
        minimumOut: q.otherAmountThreshold,
        wrapsSol: wrapsSol ? '1' : '0',
      },
    }
  }

  return {
    id: 'raydium',
    name: 'Raydium',
    kinds: ['swap'],
    quote,
    prepare,
    assertSafe: (payload: SigningPayload, account: string, context?: Record<string, string>) => {
      programsSafe(payload, account)
      if (payload.family !== 'solana') return
      assertRaydiumRoute(payload.transaction, expectationOf(context))
    },
  }
}
