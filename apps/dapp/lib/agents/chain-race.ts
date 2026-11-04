import type { ChainActionRequest } from '../chains/types'
import type { CompetitionErrorCode } from './competition'
import type { ChainRouteQuote } from './chain-routes'
import { isUnmeasuredSwap } from './settle-chain-plan'

/**
 * The route as a chain route, or nothing. A Stellar quote has no `kind`, so it
 * can never be mistaken for one and signed through the chain path.
 */
function asChainRoute(route: unknown): ChainRouteQuote | undefined {
  if (typeof route !== 'object' || route === null) return undefined
  const r = route as Partial<ChainRouteQuote>
  if (r.kind !== 'chain' || typeof r.request !== 'object' || r.request === null) return undefined
  if (typeof r.venueId !== 'string' || r.venueId === '') return undefined
  return r as ChainRouteQuote
}

/**
 * Whether a route belongs to a chain action. Loose on purpose: anything that
 * says it is a chain route must be kept away from the Stellar swap hook, even
 * if it is malformed in another way.
 */
export function isChainRoute(route: unknown): boolean {
  return (
    typeof route === 'object' && route !== null && (route as { kind?: unknown }).kind === 'chain'
  )
}

/**
 * The route the Stellar swap hook may be given. A chain route has no
 * `sendAmount`, and the hook would read it as a Stellar quote, throw, and
 * otherwise build a signable Stellar swap beside the chain's own card.
 */
export function routeForSwap(route: unknown): unknown {
  return isChainRoute(route) ? undefined : route
}

/**
 * What to prepare when the user presses Review on a route.
 *
 * Agents only ever choose a route; the amount and tokens are what the user
 * typed. So the request that gets signed is the asked one with the venue taken
 * from the route, and a route that disagrees with the ask in kind, amount or
 * either token is refused rather than corrected.
 */
export function chainRequestFor(
  route: unknown,
  asked: ChainActionRequest
): ChainActionRequest | undefined {
  const chain = asChainRoute(route)
  if (chain === undefined) return undefined
  const r = chain.request
  if (
    r.kind !== asked.kind ||
    r.amount !== asked.amount ||
    r.tokenIn !== asked.tokenIn ||
    (r.tokenOut ?? '') !== (asked.tokenOut ?? '')
  ) {
    return undefined
  }
  return { ...asked, venue: chain.venueId }
}

/** Said when only one route exists, so the race does not look like it skipped the choosing. */
export function singleRouteNote(
  routeCount: number | undefined,
  chainName: string
): string | undefined {
  if (routeCount !== 1) return undefined
  return `One route available on ${chainName}. The agents are judging whether it's worth taking.`
}

type ChainActionPhaseName =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'pending'
  | 'failed'

/** A signature is with the wallet or the network. */
export function chainSigning(phase: ChainActionPhaseName): boolean {
  return phase === 'signing' || phase === 'submitting'
}

/**
 * Review stays closed once a signature is with the wallet, was given, or the
 * outcome is unknown. After a failure that followed a signature the money may
 * have moved ("check your wallet's activity"), so a second signature is never
 * one press away; a new message starts a new race.
 */
export function chainReviewClosed(phase: ChainActionPhaseName, signed: boolean): boolean {
  return signed || chainSigning(phase) || phase === 'settled' || phase === 'pending'
}

/**
 * Whether the race is over for choosing. A signature closes it, and so does a sequence whose swap
 * settled: step 2's press lifts the latch for step 2's own card, and the race on screen is still
 * the swap's, so one more Review there would build that swap a second time.
 */
export function raceClosed(signed: boolean, sequenceSettled: boolean): boolean {
  return signed || sequenceSettled
}

/**
 * The direct-route note is true only while nothing has been signed. Step 2's card follows a swap
 * that has been, whichever route that swap took.
 */
export function showDirectNote(
  direct: boolean,
  phase: ChainActionPhaseName,
  sequenceSettled: boolean = false
): boolean {
  return direct && !sequenceSettled && (phase === 'building' || phase === 'review')
}

/** The agent that is shown as selected holds only while a build or its aftermath is live. */
export function selectionHolds(phase: ChainActionPhaseName): boolean {
  return phase !== 'idle' && phase !== 'failed'
}

export type ReviewOutcome = 'prepared' | 'refused' | 'ignored'

/**
 * Pressing Review on a chain route.
 *
 * A press while a build is under way does nothing, so one press makes one
 * build (and one deposit address). Once a signature is with the wallet or the network
 * the route can no longer change. A built card that is not yet signed may be
 * replaced by choosing another venue. Choosing its own venue again, from this agent
 * or another, builds nothing, so the deposit address on screen is the only one.
 */
export function reviewChainRoute(args: {
  route: unknown
  asked: ChainActionRequest
  text: string
  phase: ChainActionPhaseName
  /** A signature was given for this race. */
  signed?: boolean
  /** The venue of the card on screen. */
  preparedVenueId?: string | undefined
  /** The race this route was proposed in, so the signed action can be credited to it. */
  raceId?: string
  prepare: (request: ChainActionRequest, asked: string, raceId?: string) => void
  refuse: (message: string, asked: string) => void
}): ReviewOutcome {
  const { phase } = args
  if (phase === 'building') return 'ignored'
  if (chainReviewClosed(phase, args.signed === true)) return 'ignored'

  const request = chainRequestFor(args.route, args.asked)
  if (request === undefined) {
    // A good card already built is not wiped by a click that cannot be used.
    if (phase === 'review') return 'ignored'
    args.refuse(
      isChainRoute(args.route)
        ? "That route doesn't match what you asked for, so it can't be used. Nothing was signed or sent."
        : "This agent didn't choose a route, so there is nothing to review from it. Nothing was signed or sent.",
      args.text
    )
    return 'refused'
  }
  if (phase === 'review' && request.venue === args.preparedVenueId) return 'ignored'
  if (args.raceId === undefined) args.prepare(request, args.text)
  else args.prepare(request, args.text, args.raceId)
  return 'prepared'
}

/**
 * Whether a finished race left the user with nothing to review, so the direct
 * route should be built instead. A refusal (unknown token, bad amount, over
 * the cap) is not that: it is shown as written, because building would only
 * refuse again.
 */
export function needsDirectRoute(state: {
  phase: string
  winner: string | null
  anyAnswered: boolean
  error?: { code: CompetitionErrorCode }
}): boolean {
  if (state.phase !== 'decided') return false
  if (state.error !== undefined) return state.error.code !== 'action_refused'
  return state.winner === null && !state.anyAnswered
}

/**
 * How a chain route's figures read when the usual "$ avg, % vs oracle" would
 * mislead: a swap nobody could price shows as zero, which reads as perfect,
 * and a supply or stake has a rate and not a price. Undefined means the usual
 * display is right, which includes every Stellar route.
 */
export function chainFigures(route: unknown): { headline: string } | undefined {
  const chain = asChainRoute(route)
  if (chain === undefined) return undefined
  if (chain.request.kind === 'swap') {
    return isUnmeasuredSwap(chain) ? { headline: 'Price unknown' } : undefined
  }
  const apy = chain.apyPercent
  return apy !== undefined && Number.isFinite(apy)
    ? { headline: `${apy.toFixed(2)}% APY` }
    : { headline: 'Rate not available' }
}

/**
 * The figures for a proposal on a chain race. A proposal with no route has no
 * measured price or rate, and the usual zero would read as a perfect fill.
 */
export function routeFigures(
  route: unknown,
  asked: ChainActionRequest | undefined
): { headline: string } | undefined {
  if (route !== undefined) return chainFigures(route)
  if (asked === undefined) return undefined
  return { headline: asked.kind === 'swap' ? 'Price unknown' : 'Rate not available' }
}

/** The venue a route executes on: a Stellar quote's source, or a chain route's venue. */
export function routeSource(route: unknown): string | undefined {
  const r = route as { source?: unknown; venueName?: unknown } | null | undefined
  const name = r?.source ?? r?.venueName
  return typeof name === 'string' ? name : undefined
}

/**
 * The line under a decided race. Only a route with a measured price has a measured fill to be
 * best at. Anything else, such as a supply's rate, is named for what it is.
 */
export function recommendationLine(
  name: string | undefined,
  figures: { headline: string } | undefined
): string {
  const why =
    figures === undefined
      ? 'best measured fill'
      : `${figures.headline.charAt(0).toLowerCase()}${figures.headline.slice(1)}`
  return `Recommended: ${name}, ${why}. You pick who executes.`
}

export const STEP_NOT_STARTED =
  'This step did not start. The swap stands, and what arrived stays in your wallet.'

/**
 * A refusal of step 2, once the swap before it was signed. The server words its refusals as if
 * nothing had been, which is true of step 2 and false of the sequence.
 */
export function stepErrorMessage(
  message: string | undefined,
  sequenceSettled: boolean
): string | undefined {
  if (message === undefined || !sequenceSettled) return message
  if (!/nothing was signed or sent/i.test(message)) return message
  const rest = message
    .replace(/,\s*so nothing was signed or sent\.?/gi, '.')
    .replace(/\s*Nothing was signed or sent(?:, so try again in a moment)?\.?/g, '')
    .trim()
  return `${rest} ${STEP_NOT_STARTED}`
}

/**
 * The panel's error text, without the claim that nothing was signed once
 * something may have been. The server words its refusals with that sentence,
 * which is true when they are sent and false after a direct-route signature.
 */
export function panelErrorMessage(message: string, signed: boolean): string {
  if (!signed) return message
  return message
    .replace(/\s*Nothing was signed or sent\.?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
