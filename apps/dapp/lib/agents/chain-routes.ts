import type { ChainActionRequest, ChainModule } from '../chains/types'
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
  const named = request.venue?.trim().toLowerCase()
  const usable = chainApi.venues.filter(
    (v) =>
      v.kinds.includes(request.kind) &&
      v.quote !== undefined &&
      (named === undefined || v.id.toLowerCase() === named || v.name.toLowerCase().includes(named))
  )

  const settled = await Promise.all(
    usable.map(async (venue): Promise<QuotedRoute | undefined> => {
      try {
        const quoted = await venue.quote?.(request, account)
        if (quoted === undefined) return undefined
        const quote: ChainRouteQuote = {
          kind: 'chain',
          request,
          venueId: venue.id,
          venueName: venue.name,
          pay: { amount: request.amount, symbol: request.tokenIn },
          ...(quoted.receive !== undefined ? { receive: quoted.receive } : {}),
          ...(quoted.apyPercent !== undefined ? { apyPercent: quoted.apyPercent } : {}),
          ...(quoted.valueOutUsd !== undefined ? { valueOutUsd: quoted.valueOutUsd } : {}),
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
