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
  type SubmitInput,
  type SubmitResult,
} from '../types'
import { assertWrapAtMost, solanaAssertSafe } from './assert-safe'
import { JUPITER_API, jupiterHeaders, venueFetch } from './http'
import { JUPITER_SWAP_POLICY } from './programs'
import { explorerUrl, feePayerSignature } from './submit'
import { fromBaseUnits, SOLANA_TOKENS } from './tokens'

const MAX_PRICE_IMPACT_PERCENT = 3
const MAX_VALUE_LOSS = 0.05
const SLIPPAGE_BPS = 100
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'
/** Jupiter's lowest referral fee on `/order`. Only charged when an account is configured. */
const REFERRAL_FEE_BPS = 50
/**
 * JupiterZ makes a market maker the fee payer, which `assertSafe` refuses. DFlow
 * and OKX land through programs not confirmable from their docs. See programs.ts.
 */
const EXCLUDED_ROUTERS = 'jupiterz,dflow,okx'
/** `/execute` waits for the transaction to land, so it gets longer than other calls. */
const EXECUTE_TIMEOUT_MS = 70_000

const NEED_SOL_FOR_FEES =
  'This wallet needs at least 0.01 SOL to pay its own network fees before I can swap. Add a little SOL and try again.'

const Order = z.object({
  transaction: z.string().nullable().optional(),
  requestId: z.string().min(1).optional(),
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string().regex(/^\d+$/),
  outAmount: z.string().regex(/^\d+$/),
  otherAmountThreshold: z.string().regex(/^\d+$/).optional(),
  slippageBps: z.number().optional(),
  priceImpact: z.number().optional(),
  feeBps: z.number().optional(),
  router: z.string().optional(),
  gasless: z.boolean().optional(),
  taker: z.string().nullable().optional(),
  signatureFeePayer: z.string().nullable().optional(),
  rentFeeLamports: z.number().optional(),
  errorCode: z.number().optional(),
})

const Executed = z.object({
  status: z.string(),
  signature: z.string().optional(),
  code: z.number().optional(),
})

const TOKEN_NOTES: Record<string, string> = {
  ONyc: 'ONyc is tokenised reinsurance, not a $1 token. Its price can move, and redemption through OnRe has windows and holding periods, so getting out may mean selling on a market.',
  JitoSOL: 'JitoSOL is staked SOL, so its value follows the price of SOL, not the dollar.',
}

function explainOrderError(code: number | undefined, tokenIn: ChainToken): string {
  if (code === 1) {
    return `This wallet doesn't hold enough ${tokenIn.symbol} for this swap. Lower the amount or add funds.`
  }
  if (code === 2) {
    return 'This wallet doesn’t have enough SOL for network fees. Add a little SOL and try again.'
  }
  if (code === 3) return 'This swap is too small to route. Try a larger amount.'
  return 'Jupiter could not build this swap. Nothing was signed or sent. Check that you hold the token and a little SOL for fees, then try again.'
}

/**
 * A code that proves the swap did not land is a clean failure. Any other code
 * leaves open that it did, so it is reported as unknown.
 */
function explainExecuteFailure(code: number | undefined): { error: string; clean: boolean } {
  if (code === -1 || code === -1004 || code === -1005 || code === -2003) {
    return {
      error:
        'This swap expired before it landed, so nothing moved. Get a fresh quote and sign right away.',
      clean: true,
    }
  }
  if (code === -1000 || code === -2000) {
    return {
      error:
        'This swap did not land on the network, so nothing moved. Get a fresh quote and try again.',
      clean: true,
    }
  }
  if (code === -2 || code === -3 || code === -1002 || code === -1003 || code === -2002) {
    return {
      error:
        'Jupiter could not read this signed transaction, so nothing moved. Sign a fresh quote with the same wallet.',
      clean: true,
    }
  }
  return {
    error:
      'This swap did not go through. Check your wallet’s activity, then get a fresh quote if nothing changed.',
    clean: false,
  }
}

function shortAmount(amount: string): string {
  const value = Number(amount)
  return value >= 1 ? String(Number(value.toFixed(4))) : String(Number(value.toPrecision(4)))
}

function validReferral(env: Record<string, string | undefined>): string | undefined {
  const account = env['JUPITER_REFERRAL_ACCOUNT']?.trim()
  return account !== undefined && isAddress(account) ? account : undefined
}

export interface JupiterSwapOptions {
  priceUsd: (token: ChainToken) => Promise<number | undefined>
  env?: Record<string, string | undefined>
  retryDelayMs?: number
}

/**
 * Jupiter Swap's order-and-execute flow: `/order` returns a transaction for the
 * wallet to sign and `/execute` lands it, so `submit` goes back to Jupiter instead
 * of the RPC. The quote's request id travels through `PreparedAction.context`.
 */
export function createJupiterSwapVenue(options: JupiterSwapOptions): ChainVenue {
  const env = options.env ?? process.env
  const assertSafe = solanaAssertSafe(JUPITER_SWAP_POLICY)

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    if (!isAddress(account)) throw new ChainActionRefused('That is not a Solana wallet address.')
    if (request.kind !== 'swap') {
      throw new ChainActionRefused(`Jupiter swaps tokens. It can't ${request.kind} here.`)
    }
    const tokenIn = tokenBySymbol(SOLANA_TOKENS, request.tokenIn)
    const tokenOut = tokenBySymbol(SOLANA_TOKENS, request.tokenOut ?? '')
    if (tokenIn === undefined || tokenOut === undefined) {
      throw new ChainActionRefused('I can only swap tokens I have confirmed on Solana.')
    }
    const amount = toBaseUnits(request.amount, tokenIn.decimals)
    const referral = validReferral(env)

    const query = new URLSearchParams({
      inputMint: tokenIn.id,
      outputMint: tokenOut.id,
      amount,
      taker: account,
      slippageBps: String(SLIPPAGE_BPS),
      excludeRouters: EXCLUDED_ROUTERS,
      ...(referral !== undefined
        ? { referralAccount: referral, referralFee: String(REFERRAL_FEE_BPS) }
        : {}),
    })
    const { status, body } = await venueFetch(`${JUPITER_API}/swap/v2/order?${query}`, {
      label: 'Jupiter',
      headers: jupiterHeaders(env),
      ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    })
    const parsed = Order.safeParse(body)
    if (status !== 200 || !parsed.success) {
      throw new ChainActionRefused(
        'Jupiter could not build this swap. Nothing was signed or sent. Check that you hold the token and a little SOL for fees, then try again.'
      )
    }
    const order = parsed.data

    if (
      order.inputMint !== tokenIn.id ||
      order.outputMint !== tokenOut.id ||
      order.inAmount !== amount ||
      order.taker !== account
    ) {
      throw new ChainActionRefused(
        'Jupiter returned a quote that is not what you asked for, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (order.transaction === undefined || order.transaction === null || order.transaction === '') {
      throw new ChainActionRefused(explainOrderError(order.errorCode, tokenIn))
    }
    if (order.gasless === true || order.signatureFeePayer !== account) {
      throw new ChainActionRefused(NEED_SOL_FOR_FEES)
    }
    if (order.router !== 'metis') {
      throw new ChainActionRefused(
        'Jupiter offered a route I can’t check, so I stopped here. Nothing was signed or sent. Try again in a moment.'
      )
    }
    if (order.requestId === undefined || order.otherAmountThreshold === undefined) {
      throw new ChainActionRefused(
        'This quote could not be checked because it was missing details. Nothing was signed or sent, so try again in a moment.'
      )
    }
    if (order.slippageBps === undefined || order.slippageBps > SLIPPAGE_BPS) {
      throw new ChainActionRefused(
        'This quote allows more slippage than the 1% I accept, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (order.priceImpact === undefined) {
      throw new ChainActionRefused(
        'Jupiter did not report this swap’s price impact, so I stopped here. Nothing was signed or sent.'
      )
    }
    if (Math.abs(order.priceImpact) > MAX_PRICE_IMPACT_PERCENT) {
      throw new ChainActionRefused(
        `This swap has a price impact of about ${Math.abs(order.priceImpact).toFixed(1)}%, above the ${MAX_PRICE_IMPACT_PERCENT}% I accept. There isn't enough liquidity for this size, so try a smaller amount.`
      )
    }

    const minimum = fromBaseUnits(order.otherAmountThreshold, tokenOut.decimals)
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
        `At worst this swap returns about $${valueOut.toFixed(2)} of ${tokenOut.symbol} for $${valueIn.toFixed(2)} of ${tokenIn.symbol}, more than ${MAX_VALUE_LOSS * 100}% less than it is worth. That usually means thin liquidity, so I stopped here. Try a smaller amount or another token.`
      )
    }

    if (tokenIn.id === WRAPPED_SOL) assertWrapAtMost(order.transaction, BigInt(amount))

    const received = fromBaseUnits(order.outAmount, tokenOut.decimals)
    const notes = [
      `The price can move before this lands. You get at least ${minimum} ${tokenOut.symbol} or the swap fails, and network fees still apply.`,
    ]
    const tokenNote = TOKEN_NOTES[tokenOut.symbol]
    if (tokenNote !== undefined) notes.push(tokenNote)
    if (referral !== undefined) {
      notes.push(
        `This swap includes a ${REFERRAL_FEE_BPS / 100}% fee to Intent, already taken from the amount shown.`
      )
    } else if ((order.rentFeeLamports ?? 0) > 0) {
      notes.push(
        `Your wallet also pays about ${fromBaseUnits(String(order.rentFeeLamports), 9)} SOL to open a token account for ${tokenOut.symbol}.`
      )
    }

    return {
      venueId: 'jupiter',
      venueName: 'Jupiter',
      kind: 'swap',
      summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${shortAmount(received)} ${tokenOut.symbol} through Jupiter.`,
      pay: { amount: request.amount, symbol: tokenIn.symbol },
      receive: { amount: received, symbol: tokenOut.symbol, approximate: true },
      notes,
      signing: { family: 'solana', transaction: order.transaction },
      context: { requestId: order.requestId },
    }
  }

  async function submit(input: SubmitInput): Promise<SubmitResult> {
    if (input.signed.family !== 'solana') {
      return { ok: false, error: 'That is not a Solana transaction.' }
    }
    const requestId = input.context?.['requestId']
    if (requestId === undefined || requestId === '') {
      return {
        ok: false,
        error:
          'This swap lost track of its quote, so nothing was sent. Get a fresh quote and sign it.',
      }
    }
    const { signedTransaction } = input.signed
    if (feePayerSignature(signedTransaction) === undefined) {
      return {
        ok: false,
        error: 'Your wallet returned this unsigned, so nothing was sent. Sign it again.',
      }
    }

    const response = await fetch(`${JUPITER_API}/swap/v2/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...jupiterHeaders(env) },
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    })
    // A server failure or timeout leaves the outcome unknown. Throwing sends it to the
    // route, which tells the user to check their wallet before trying again.
    if (response.status >= 500 || response.status === 429) {
      throw new Error(`Jupiter /execute answered ${response.status}`)
    }
    const parsed = Executed.safeParse(await response.json().catch(() => undefined))
    // A 200 whose body cannot be read says nothing about whether the swap landed.
    if (response.ok && !parsed.success) {
      return {
        ok: false,
        pending: true,
        error:
          'Jupiter answered, but the reply could not be read, so this swap may have gone through. Check your wallet’s activity before trying again.',
      }
    }
    if (!response.ok || !parsed.success) {
      return {
        ok: false,
        error:
          'Jupiter would not take this swap, so nothing was sent. Get a fresh quote and try again.',
      }
    }
    const { status, signature, code } = parsed.data
    if (status === 'Success' && signature !== undefined) {
      return { ok: true, hash: signature, explorerUrl: explorerUrl(signature) }
    }
    const failure = explainExecuteFailure(code)
    return failure.clean
      ? { ok: false, error: failure.error }
      : { ok: false, pending: true, error: failure.error }
  }

  return {
    id: 'jupiter',
    name: 'Jupiter',
    kinds: ['swap'],
    prepare,
    assertSafe,
    submit,
  }
}
