import { AggregatorClient } from '@cetusprotocol/aggregator-sdk'
import { Transaction } from '@mysten/sui/transactions'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenueQuote,
} from '../types'
import { cetusOverlay, judgeRoute, SLIPPAGE_BPS } from './cetus-rules'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import { CETUS_POLICY, CETUS_PROVIDERS } from './policies'
import { priceFromLlama } from './price'
import { assertPtbSafe } from './safety'
import { displayAmount, SUI_TOKENS } from './tokens'

const QUOTE_TIMEOUT_MS = 10_000
const VENUE_NAME = 'Cetus Aggregator'

function notes(tokens: string[], slippagePercent: number, feeBps: number | undefined): string[] {
  const bridged = tokens.includes('USDT')
    ? ' USDT on Sui is a bridged token, so it also depends on the Sui Bridge.'
    : ''
  return [
    `The amount you get can move before this lands. If it drops by more than ${slippagePercent}%, the swap cancels and you only pay the network fee.`,
    `This runs through third-party contracts that can fail. Cetus lost about $223M to an exploit in May 2025 and has since relaunched.${bridged}`,
    ...(feeBps === undefined
      ? []
      : [
          `Intent takes a ${feeBps / 100}% fee from what you receive. The amount shown already includes it.`,
        ]),
  ]
}

/** The best route and every check on it. The race and Review both go through this. */
async function bestRoute(request: ChainActionRequest, account: string) {
  assertSuiAccount(account)
  const tokenIn = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  const tokenOut = tokenBySymbol(SUI_TOKENS, request.tokenOut ?? '')
  if (tokenIn === undefined || tokenOut === undefined) {
    throw new ChainActionRefused("I can't confirm those as verified tokens on Sui.")
  }
  const requestedIn = toBaseUnits(request.amount, tokenIn.decimals)

  const client = suiClient()
  const overlay = cetusOverlay()
  const aggregator = new AggregatorClient({
    client,
    signer: account,
    ...(overlay === undefined
      ? {}
      : { overlayFeeRate: overlay.bps / 10_000, overlayFeeReceiver: overlay.receiver }),
  })
  const slippage = SLIPPAGE_BPS / 10_000

  const [priceIn, priceOut, route] = await Promise.all([
    priceFromLlama(tokenIn),
    priceFromLlama(tokenOut),
    withTimeout(
      aggregator.findRouters({
        from: tokenIn.id,
        target: tokenOut.id,
        amount: requestedIn,
        byAmountIn: true,
        slippage,
        providers: CETUS_PROVIDERS,
      }),
      QUOTE_TIMEOUT_MS,
      'Finding a route'
    ),
  ])
  if (route === null || route.error !== undefined || route.paths.length === 0) {
    throw new ChainActionRefused(
      `I couldn't find a route from ${tokenIn.symbol} to ${tokenOut.symbol} right now. Try again shortly.`
    )
  }
  const amountOut = route.amountOut.toString()
  judgeRoute({
    requestedIn,
    amountIn: route.amountIn.toString(),
    amountOut,
    deviationRatio: route.deviationRatio,
    tokenIn,
    tokenOut,
    priceIn,
    priceOut,
  })
  return { tokenIn, tokenOut, client, overlay, aggregator, slippage, route, amountOut }
}

/** What the route would give back. Builds nothing, so nothing here could be signed. */
async function quote(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  const { tokenOut, amountOut } = await bestRoute(request, account)
  return {
    receive: { amount: displayAmount(amountOut, tokenOut.decimals), symbol: tokenOut.symbol },
  }
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const { tokenIn, tokenOut, client, overlay, aggregator, slippage, route, amountOut } =
    await bestRoute(request, account)

  const tx = new Transaction()
  tx.setSender(account)
  await withTimeout(
    aggregator.fastRouterSwap({ router: route, txb: tx, slippage }),
    QUOTE_TIMEOUT_MS,
    'Building the swap'
  )
  const transaction = await buildUnsigned(tx, client, tokenIn.symbol)

  const receive = displayAmount(amountOut, tokenOut.decimals)
  return {
    venueId: 'cetus',
    venueName: VENUE_NAME,
    kind: 'swap',
    summary: `Swap ${request.amount} ${tokenIn.symbol} for about ${receive} ${tokenOut.symbol} through Cetus.`,
    pay: { amount: request.amount, symbol: tokenIn.symbol },
    receive: { amount: receive, symbol: tokenOut.symbol, approximate: true },
    notes: notes([tokenIn.symbol, tokenOut.symbol], SLIPPAGE_BPS / 100, overlay?.bps),
    signing: { family: 'sui', transaction },
  }
}

export const cetusVenue: ChainVenue = {
  id: 'cetus',
  name: VENUE_NAME,
  kinds: ['swap'],
  quote,
  prepare,
  assertSafe: (payload: SigningPayload, account: string) =>
    assertPtbSafe(payload, account, CETUS_POLICY),
}
