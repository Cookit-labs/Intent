import { limitPair } from '../chains/limit'
import type { ChainActionRequest, ChainModule } from '../chains/types'
import type { ChainRouteQuote } from './chain-routes'

/** A resting order the agents may propose instead of filling now. */
export interface RestOption {
  venueId: string
  venueName: string
  /** Dollars per unit of the token that is not the stablecoin. */
  marketUsd: number
  /** The person gives up the non-stable token. */
  selling: boolean
  cost?: { amount: string; symbol: string }
  notes: string[]
}

/**
 * The resting order a swap could use, or nothing: only a plain swap against a stablecoin, with no
 * venue named, on a chain that has a limit venue.
 */
export function restOption(
  chainApi: ChainModule,
  request: ChainActionRequest,
  marketUsd: number
): RestOption | undefined {
  if (request.kind !== 'swap' || request.venue !== undefined || request.tokenOut === undefined) {
    return undefined
  }
  if (!Number.isFinite(marketUsd) || marketUsd <= 0) return undefined
  const pair = limitPair(request.tokenIn, request.tokenOut)
  if (pair === undefined) return undefined
  const venue = chainApi.venues.find((v) => v.kinds.includes('limit'))
  if (venue === undefined) return undefined
  return {
    venueId: venue.id,
    venueName: venue.name,
    marketUsd,
    selling: pair.selling,
    ...(venue.limitCost !== undefined ? { cost: venue.limitCost } : {}),
    notes: [],
  }
}

/** Where an agent may rest: 0.1% to 5% better than the market, `least` the nearest, `most` the furthest. */
export function restBand(marketUsd: number, selling: boolean): { least: number; most: number } {
  return selling
    ? { least: marketUsd * 1.001, most: marketUsd * 1.05 }
    : { least: marketUsd * 0.999, most: marketUsd * 0.95 }
}

export function priceInBand(price: number, rest: RestOption): boolean {
  if (!Number.isFinite(price) || price <= 0) return false
  const { least, most } = restBand(rest.marketUsd, rest.selling)
  const slack = rest.marketUsd * 1e-9
  return rest.selling
    ? price >= least - slack && price <= most + slack
    : price <= least + slack && price >= most - slack
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

/** The route as the person will see it when an agent rests: the limit venue, at the price. */
export function restRoute(
  quote: ChainRouteQuote,
  rest: RestOption,
  priceUsd: number
): ChainRouteQuote {
  return {
    ...quote,
    rest: {
      venueId: rest.venueId,
      venueName: rest.venueName,
      priceUsd,
      ...(rest.cost !== undefined ? { cost: rest.cost } : {}),
    },
  }
}

/** The lines the agents are shown when resting is possible. */
export function restContextLines(rest: RestOption): string[] {
  const band = restBand(rest.marketUsd, rest.selling)
  const [near, far] = [band.least, band.most].map((n) => n.toFixed(4))
  return [
    '',
    `Resting option: ${rest.venueName} can hold a limit order instead of filling now.`,
    `The market price is about ${money(rest.marketUsd)}. A resting price must be between $${near} and $${far}, otherwise the plan becomes a fill.`,
    rest.cost !== undefined
      ? `Placing it costs about ${rest.cost.amount} ${rest.cost.symbol}, and it may never fill.`
      : 'It may never fill.',
    ...rest.notes,
  ]
}

interface RestView {
  executionMode?: string | undefined
  restPriceUsd?: number | undefined
  source?: string | undefined
  restCost?: { amount: string; symbol: string } | undefined
}

function costWord(cost: { amount: string; symbol: string }): string {
  return `${Number(Number(cost.amount).toPrecision(2))} ${cost.symbol}`
}

/** The other way to do it, said beside the recommendation when some agents would rest. */
export function restAlternativeLine(proposals: readonly RestView[]): string | undefined {
  const resting = proposals.filter((p) => p.executionMode === 'rest')
  if (resting.length === 0 || resting.length === proposals.length) return undefined
  const first = resting[0]
  if (first === undefined) return undefined
  const who = resting.length === 1 ? '1 agent suggests' : `${resting.length} agents suggest`
  const at = first.restPriceUsd !== undefined ? ` at ${money(first.restPriceUsd)}` : ''
  const through = first.source !== undefined ? ` through ${first.source}` : ''
  const cost = first.restCost !== undefined ? `costs about ${costWord(first.restCost)}, ` : ''
  return `${who} resting${at}${through}: it could get more, ${cost}and may never fill. You choose.`
}
