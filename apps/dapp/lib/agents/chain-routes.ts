import { namedVenue, venueAnswersTo } from '../chains/prepare'
import { tokenBySymbol, type ChainActionRequest, type ChainModule } from '../chains/types'
import type { ParsedIntent } from '../parse-intent'
import type { QuotedRoute } from './brain'

/** What a chain route carries as its `quote`, so the winner can be prepared for signing. */
export interface ChainRouteQuote {
  kind: 'chain'
  request: ChainActionRequest
  venueId: string
  venueName: string
  pay: { amount: string; symbol: string }
  receive?: { amount: string; symbol: string }
  apyPercent?: number
  valueInUsd?: number
  valueOutUsd?: number
  /** An agent proposed resting instead of this fill: the limit venue and the price it waits at. */
  rest?: {
    venueId: string
    venueName: string
    priceUsd: number
    cost?: { amount: string; symbol: string }
  }
}

/**
 * Prices the action at every venue that can do it and has a quote to give.
 *
 * A venue that errors is left out rather than failing the race: the agents
 * choose between the prices that exist. A venue with no `quote` is skipped
 * because it has no honest figure to offer, and a made-up one would be judged
 * as if it were real.
 */
export async function quoteChainRoutes(
  chainApi: ChainModule,
  request: ChainActionRequest,
  account: string
): Promise<QuotedRoute[]> {
  const named = namedVenue(chainApi, request)
  const usable = chainApi.venues.filter(
    (v) =>
      v.kinds.includes(request.kind) &&
      v.quote !== undefined &&
      (named === undefined || venueAnswersTo(v, named))
  )

  // Dollars per display unit, from the chain's own price source. Display
  // amounts times this is the only value computed here: base units are never
  // converted, because token decimals differ from chain to chain.
  const priceOf = async (symbol: string): Promise<number | undefined> => {
    const token = tokenBySymbol(chainApi.tokens, symbol)
    if (token === undefined) return undefined
    const price = await chainApi.priceUsd(token).catch(() => undefined)
    return price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined
  }
  const priceIn = await priceOf(request.tokenIn)
  const amountIn = Number(request.amount)
  const valueInUsd =
    priceIn !== undefined && Number.isFinite(amountIn) ? amountIn * priceIn : undefined

  const settled = await Promise.all(
    usable.map(async (venue): Promise<QuotedRoute | undefined> => {
      try {
        const quoted = await venue.quote?.(request, account)
        if (quoted === undefined) return undefined
        // The venue's own dollar figure when it gives one; otherwise what it
        // says it will hand over, priced here. Unpriced stays unknown.
        let valueOutUsd = quoted.valueOutUsd
        if (valueOutUsd === undefined && quoted.receive !== undefined) {
          const priceOut = await priceOf(quoted.receive.symbol)
          const qty = Number(quoted.receive.amount)
          if (priceOut !== undefined && Number.isFinite(qty)) valueOutUsd = qty * priceOut
        }
        // A cost that can't be priced leaves what the route is worth unknown, not free of it.
        // So does one that swallows the swap: the agents are never shown a negative value.
        if (quoted.walletCost !== undefined && valueOutUsd !== undefined) {
          const priceCost = await priceOf(quoted.walletCost.symbol)
          const net =
            priceCost === undefined
              ? undefined
              : valueOutUsd - Number(quoted.walletCost.amount) * priceCost
          valueOutUsd = net !== undefined && net > 0 ? net : undefined
        }
        const quote: ChainRouteQuote = {
          kind: 'chain',
          request,
          venueId: venue.id,
          venueName: venue.name,
          pay: { amount: request.amount, symbol: request.tokenIn },
          ...(quoted.receive !== undefined ? { receive: quoted.receive } : {}),
          ...(quoted.apyPercent !== undefined ? { apyPercent: quoted.apyPercent } : {}),
          ...(valueInUsd !== undefined ? { valueInUsd } : {}),
          ...(valueOutUsd !== undefined ? { valueOutUsd } : {}),
        }
        return {
          id: `${venue.id}-1`,
          source: venue.name,
          sendAmount: request.amount,
          receiveAmount: quoted.receive?.amount ?? '',
          hops: 1,
          executable: true,
          quote,
        }
      } catch {
        return undefined
      }
    })
  )
  return settled.filter((r): r is QuotedRoute => r !== undefined)
}

/**
 * The least a `ParsedIntent` needs so the brain and the race log keep their
 * types. Built from the structured request, never by reading words again: the
 * chain, token and amount were already settled by the chat.
 */
export function intentFromChainAction(
  request: ChainActionRequest,
  text: string,
  priceUsd: number | undefined
): ParsedIntent {
  const tokenOut = request.kind === 'swap' ? (request.tokenOut ?? request.tokenIn) : request.tokenIn
  const escrowUsd = priceUsd === undefined ? 0 : Math.round(Number(request.amount) * priceUsd)
  return {
    outcome: text,
    escrowUsd,
    referencePriceUsd: priceUsd ?? 0,
    targetPriceUsd: priceUsd ?? 0,
    input: {
      type: 'market_sell',
      tokenIn: request.tokenIn,
      tokenOut,
      amountIn: request.amount,
      minAmountOut: '0',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  }
}
