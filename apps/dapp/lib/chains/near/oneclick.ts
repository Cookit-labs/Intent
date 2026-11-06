import { z } from 'zod'

import { ChainActionRefused, type ChainToken } from '../types'
import { NEAR_ACCOUNT } from './account'
import { verifyQuoteSignature } from './quote-signature'

const BASE_URL = 'https://1click.chaindefuser.com/v0'
const TOKENS_TIMEOUT_MS = 10_000
const QUOTE_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MS = 4_000
const TOKENS_CACHE_MS = 30_000
/** A price older than this is not a live price, so the trade is refused rather than valued on it. */
const MAX_PRICE_AGE_MS = 15 * 60_000
/** The combined fee limit is 500 bps, and 1Click adds 25 of its own without a key. */
const MAX_APP_FEE_BPS = 475

/**
 * A NEAR token's asset id, which is its account by rule. Other chains' ids can't be worked
 * out from a contract, so they come from the list through `oneClickAssetId`.
 */
export function assetIdOf(token: ChainToken): string {
  return `nep141:${token.id}`
}

function headers(json: boolean): Record<string, string> {
  const key = process.env['ONECLICK_API_KEY']?.trim()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(key !== undefined && key !== '' ? { 'X-API-Key': key } : {}),
  }
}

/** Returns nothing unless both settings are present and sensible, so a bad setting can't overcharge. */
export function appFees(): { recipient: string; fee: number }[] | undefined {
  const bps = Number(process.env['ONECLICK_APP_FEE_BPS']?.trim())
  const recipient = process.env['ONECLICK_APP_FEE_RECIPIENT']?.trim()
  if (recipient === undefined || !NEAR_ACCOUNT.test(recipient)) return undefined
  if (!Number.isInteger(bps) || bps < 1 || bps > MAX_APP_FEE_BPS) return undefined
  return [{ recipient, fee: bps }]
}

const TokenList = z.array(
  z.object({
    assetId: z.string(),
    decimals: z.number(),
    symbol: z.string(),
    price: z.number().optional(),
    priceUpdatedAt: z.string().optional(),
    // Allowed to be null so that a change to these can't stop NEAR's prices from being read.
    blockchain: z.string().nullish(),
    contractAddress: z.string().nullish(),
  })
)
export type OneClickToken = z.infer<typeof TokenList>[number]

let tokenCache: { at: number; tokens: OneClickToken[] } | undefined

export function clearTokenCache(): void {
  tokenCache = undefined
}

export async function listTokens(): Promise<OneClickToken[]> {
  if (tokenCache !== undefined && Date.now() - tokenCache.at < TOKENS_CACHE_MS) {
    return tokenCache.tokens
  }
  const response = await fetch(`${BASE_URL}/tokens`, {
    headers: headers(false),
    signal: AbortSignal.timeout(TOKENS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`1Click tokens responded ${response.status}`)
  const tokens = TokenList.parse(await response.json())
  tokenCache = { at: Date.now(), tokens }
  return tokens
}

/**
 * Dollars per display unit from the 1Click list, matched on the exact asset id
 * because the list repeats symbols: it has two NEAR-chain USDTs. Stablecoins get
 * the listed price too, since it is not exactly 1. Nothing on any doubt.
 */
export async function oneClickPrice(
  assetId: string,
  decimals: number
): Promise<number | undefined> {
  try {
    const entry = (await listTokens()).find((t) => t.assetId === assetId)
    if (entry === undefined || entry.decimals !== decimals) return undefined
    const { price, priceUpdatedAt } = entry
    if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined
    const age = Date.now() - Date.parse(priceUpdatedAt ?? '')
    if (!Number.isFinite(age) || age > MAX_PRICE_AGE_MS) return undefined
    return price
  } catch {
    return undefined
  }
}

const Digits = z.string().regex(/^\d+$/)

const Quote = z.object({
  amountIn: Digits,
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: Digits,
  amountOut: Digits,
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: Digits,
  timeEstimate: z.number().optional(),
  refundFee: Digits.optional(),
  withdrawFee: Digits.optional(),
  deadline: z.string().optional(),
  timeWhenInactive: z.string().optional(),
  depositAddress: z.string().optional(),
  depositMemo: z.string().optional(),
})

const QuoteRequestEcho = z
  .object({
    dry: z.boolean(),
    swapType: z.string(),
    slippageTolerance: z.number(),
    originAsset: z.string(),
    depositType: z.string(),
    destinationAsset: z.string(),
    amount: z.string(),
    refundTo: z.string(),
    refundType: z.string(),
    recipient: z.string(),
    recipientType: z.string(),
    deadline: z.string(),
    appFees: z.array(z.object({ fee: z.number() }).passthrough()).optional(),
  })
  .passthrough()

const QuoteEnvelope = z.object({
  quote: Quote.passthrough(),
  quoteRequest: QuoteRequestEcho,
  signature: z.string(),
  timestamp: z.string(),
})
export type QuoteEnvelope = z.infer<typeof QuoteEnvelope>

export interface QuoteInput {
  dry: boolean
  originAsset: string
  destinationAsset: string
  amount: string
  account: string
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS'
  deadline: string
  slippageBps: number
  /** The money already sits in the person's NEAR Intents balance, and any refund goes back there. */
  fromIntents?: boolean | undefined
}

/** A sentence for what 1Click said. Its own text is not passed on, because it is outside this app. */
function refusalFor(status: number, message: string): ChainActionRefused {
  if (/not available/i.test(message)) {
    return new ChainActionRefused(
      "NEAR Intents isn't offering this route right now, and a different amount won't change that. Nothing was signed or sent."
    )
  }
  if (/no liquidity/i.test(message)) {
    return new ChainActionRefused(
      'NEAR Intents has no price for this right now, usually because the amount is too small or too large for the market. Try a different amount, or try again in a minute. Nothing was signed or sent.'
    )
  }
  if (/minimum|too low|too small|temporary swap limit/i.test(message)) {
    const dollars = /\$[\d,]+(?:\.\d+)?/.exec(message)?.[0]
    return new ChainActionRefused(
      dollars !== undefined
        ? `NEAR Intents won't take less than ${dollars} on this route right now. Try a larger amount. Nothing was signed or sent.`
        : 'This amount is below what NEAR Intents takes on this route right now. Try a larger amount. Nothing was signed or sent.'
    )
  }
  if (status === 401 || status === 403) {
    return new ChainActionRefused(
      'NEAR Intents turned this app away, so its API key needs checking. Nothing was signed or sent.'
    )
  }
  if (status === 429) {
    return new ChainActionRefused(
      'NEAR Intents is limiting requests right now. Try again in a minute. Nothing was signed or sent.'
    )
  }
  return new ChainActionRefused(
    'NEAR Intents would not quote this. Try again in a minute, or try a different amount. Nothing was signed or sent.'
  )
}

/**
 * One quote, with its signature checked. Throws `ChainActionRefused` for anything
 * the user should read. A `dry: false` quote creates a deposit address and moves
 * nothing.
 */
export async function requestQuote(input: QuoteInput): Promise<QuoteEnvelope> {
  const fees = appFees()
  const funding = input.fromIntents === true ? 'INTENTS' : 'ORIGIN_CHAIN'
  const body = {
    dry: input.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: input.slippageBps,
    originAsset: input.originAsset,
    depositType: funding,
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    refundTo: input.account,
    refundType: funding,
    recipient: input.account,
    recipientType: input.recipientType,
    deadline: input.deadline,
    ...(fees !== undefined ? { appFees: fees } : {}),
  }

  let response: Response
  try {
    response = await fetch(`${BASE_URL}/quote`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    })
  } catch {
    throw new ChainActionRefused(
      "NEAR Intents isn't answering right now. Try again in a minute. Nothing was signed or sent."
    )
  }
  const raw: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = (raw as { message?: unknown } | undefined)?.message
    throw refusalFor(response.status, typeof message === 'string' ? message : '')
  }
  const parsed = QuoteEnvelope.safeParse(raw)
  if (!parsed.success) {
    throw new ChainActionRefused(
      'NEAR Intents sent back a quote this app cannot read, so it was not used. Nothing was signed or sent.'
    )
  }
  if (!verifyQuoteSignature(parsed.data)) {
    throw new ChainActionRefused(
      "NEAR Intents' quote failed its signature check, so it was not used. Nothing was signed or sent."
    )
  }
  return parsed.data
}

/**
 * Optional speed-up, per the docs. A failure here changes nothing about the swap. The sender
 * account only means something on NEAR, so other chains leave it out.
 */
export async function notifyDeposit(
  depositAddress: string,
  txHash: string,
  nearSenderAccount?: string
): Promise<void> {
  await fetch(`${BASE_URL}/deposit/submit`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ txHash, depositAddress, nearSenderAccount }),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  }).catch(() => undefined)
}

const StatusBody = z.object({
  status: z.string().optional(),
  quoteResponse: z
    .object({
      quoteRequest: z.object({ recipient: z.string().optional() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
})
export type DepositStatus = z.infer<typeof StatusBody>

/** The swap's state, or nothing while the answer can't be read. */
export async function depositStatus(depositAddress: string): Promise<DepositStatus | undefined> {
  try {
    const response = await fetch(
      `${BASE_URL}/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      { headers: headers(false), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }
    )
    if (!response.ok) return undefined
    const parsed = StatusBody.safeParse(await response.json())
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
