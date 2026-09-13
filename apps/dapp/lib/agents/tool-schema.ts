import { z } from 'zod'

import type { ClassicAsset } from '../swap/assets'
import type { OrderBookTop } from '../swap/limit-price'
import { wouldCrossSpread } from '../swap/limit-price'

/**
 * The single tool every agent calls to answer.
 *
 * Two schemas, deliberately. The JSON Schema is what the provider enforces in
 * strict mode; it constrains *shape* but cannot express ranges — strict mode
 * rejects `minLength`, `maxLength`, `minItems` and `maxItems`. So a
 * schema-valid response can still claim 400% slippage or a fill price ten times
 * the market. The Zod schema is what catches that, and it runs on every
 * response regardless of whether strict mode was used.
 *
 * `tool-schema.test.ts` asserts the two stay in step.
 */

/** Strict mode requires every property listed in `required` and no extras. */
export const SUBMIT_PROPOSAL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_proposal',
    description: 'Submit your execution proposal for this intent.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        routeId: {
          type: 'string',
          description:
            'The id of the route you are choosing from the offered list. Use the empty string only when no routes were offered.',
        },
        reasoning: {
          type: 'string',
          description:
            'At most two sentences explaining your plan, shown directly to the user. Be concrete and quantitative.',
        },
        projectedAvgPriceUsd: {
          type: 'number',
          description:
            'The rate this trade fills at, expressed as units of the asset being SPENT per one unit of the asset being RECEIVED. Read it straight off the route you chose: divide its send amount by its receive amount. Do not convert to dollars, do not multiply by a market price, and do not reconcile it against the reference figure — those are different numbers and mixing them produces one that matches nothing.',
        },
        projectedSlippagePct: {
          // The bound is stated because it is enforced. Leaving it out of the
          // schema rejected proposals for exceeding a limit the model was
          // never told about, which reads as the model failing rather than the
          // contract being incomplete.
          type: 'number',
          minimum: 0,
          maximum: 5,
          description:
            'Projected slippage as a percentage, e.g. 0.18 for 0.18%. Must be between 0 and 5.',
        },
        venues: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venue ids you would route through. Must come from the supplied venue list.',
        },
        sliceCount: {
          type: 'integer',
          description: 'Number of slices. 1 means a single fill.',
        },
        confidence: {
          type: 'number',
          description: 'Your confidence in this plan, 0 to 1.',
        },
        horizonMinutes: {
          type: 'integer',
          description: 'Minutes over which the execution completes.',
        },
        executionMode: {
          type: 'string',
          enum: ['fill', 'rest', 'split'],
          description:
            'How this plan executes. "fill" trades immediately at the current market. "rest" places an order on the book and waits. "split" does both in one atomic transaction: part filled now, the remainder rested at your price — use it when filling everything moves the price against you but waiting for everything risks not trading at all.',
        },
        splitPct: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description:
            'When executionMode is "split", the percentage to fill immediately; the rest is placed on the book. Must be between 1 and 99. Use 0 otherwise.',
        },
        restPriceUsd: {
          type: 'number',
          description:
            'The price to rest at, in USD per unit of the asset being bought. Required when executionMode is "rest"; use 0 when filling now.',
        },
      },
      required: [
        // Strict mode requires every property, so routeId is listed here and
        // an empty string is the "no route offered" case rather than omission.
        'routeId',
        'reasoning',
        'projectedAvgPriceUsd',
        'projectedSlippagePct',
        'venues',
        'sliceCount',
        'confidence',
        'horizonMinutes',
        'executionMode',
        'restPriceUsd',
        'splitPct',
      ],
    },
  },
}

/** Reasoning is rendered in a chat bubble, so an essay is a defect. */
export const MAX_REASONING_CHARS = 240

/** Above this, a projection is not a plan — it is a hallucination. */
export const MAX_SLIPPAGE_PCT = 5

/** How far a projected fill may stray from the reference price. */
export const MAX_PRICE_DEVIATION = 0.2

export const proposalToolSchema = z.object({
  routeId: z.string(),
  reasoning: z.string().trim().min(1),
  projectedAvgPriceUsd: z.number().finite().positive(),
  projectedSlippagePct: z.number().finite().min(0).max(MAX_SLIPPAGE_PCT),
  venues: z.array(z.string()),
  sliceCount: z.number().int().min(1).max(50),
  confidence: z.number().min(0).max(1),
  // Up to a week. The original 24h cap rejected otherwise-sound proposals:
  // an accumulate intent is a multi-day plan by nature, so a longer horizon is
  // the strategy working rather than a bad value. The bound still exists to
  // catch a nonsense figure.
  horizonMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 7),
  // The plan itself, rather than a description of one. Without this every
  // agent's proposal reached the same builder and produced the same
  // transaction, so choosing between them changed nothing.
  executionMode: z.enum(['fill', 'rest', 'split']),
  // Zero on any non-split proposal. Strict mode admits no optional
  // properties, so absence has to be expressed as a value.
  splitPct: z.number().int().min(0).max(100),
  // Zero when filling. Strict mode admits no optional properties, so absence
  // has to be expressed as a value rather than an omission.
  restPriceUsd: z.number().finite().min(0),
})

export type ProposalToolInput = z.infer<typeof proposalToolSchema>

export interface ValidationContext {
  referencePriceUsd: number
  /**
   * A second legitimate price basis, when one exists.
   *
   * On testnet the route rate and the real market rate genuinely disagree —
   * synthetic liquidity puts XLM near $1.71 against a real ~$0.19 — and both
   * are defensible answers to "what will this fill at". Validating against a
   * single basis rejected every honest proposal and silently replaced all four
   * agents with canned mock text, which is how one agent appeared to win every
   * competition.
   */
  altReferencePriceUsd?: number
  /**
   * The rate each offered route implies.
   *
   * An agent may choose any route it was shown, so each one's rate is a
   * legitimate answer. Judging every proposal against a single route's price
   * meant an agent picking the better venue was rejected for quoting it —
   * which is what silently replaced all four live agents with canned mock
   * proposals citing venues that do not exist on this chain.
   */
  routeRates?: number[]
  allowedVenueIds: string[]
  /**
   * Ids the agent may choose from. A route naming anything outside this set is
   * rejected outright rather than substituted: unlike a venue label, a route id
   * is about to be executed, and guessing at one would sign the wrong trade.
   */
  allowedRouteIds?: string[]
}

/**
 * Applies the checks the provider's schema cannot.
 *
 * Unknown venues are dropped rather than rejected: naming a venue that does not
 * exist is a small, common slip, and discarding the bad id keeps an otherwise
 * sound proposal in the race. A price far from reference is rejected outright,
 * because that number is shown to the user as a projected fill.
 */
export function validateProposal(
  raw: unknown,
  ctx: ValidationContext
): { ok: true; value: ProposalToolInput } | { ok: false; reason: string } {
  const parsed = proposalToolSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'schema mismatch' }
  }

  const value = parsed.data

  // Near *either* basis is plausible. The guard exists to catch a fabricated
  // number, not to force a choice between two prices the app itself reports.
  const stated = [
    ctx.referencePriceUsd,
    ctx.altReferencePriceUsd,
    ...(ctx.routeRates ?? []),
  ].filter((b): b is number => b !== undefined && b > 0)

  // A rate is only meaningful with a direction, and "average fill price" does
  // not carry one. Buying XLM with USDC, the model quotes ~1.72 USDC per XLM
  // while both references describe the same trade as ~0.18 XLM per USDC — the
  // guard was comparing a rate against its own reciprocal and rejecting every
  // agent, which dropped the whole competition to canned mock proposals that
  // carry no route and therefore cannot be signed.
  /*
   * A rate is only meaningful with a direction, and "average fill price" does
   * not carry one: buying XLM with USDC, a model may quote either USDC per XLM
   * or XLM per USDC. Both are honest, so both directions are accepted.
   */
  const bases = [...stated, ...stated.map((b) => 1 / b)]

  /*
   * Proximity to a basis, not membership of a range.
   *
   * Each basis is a real answer someone could give — a route's rate, the
   * market reference, or either inverted — and a proposal is plausible when it
   * is close to one of them. Accepting the whole span between the lowest and
   * highest instead would admit any number in a ten-fold range, which on
   * testnet is most numbers.
   */
  const implausible =
    bases.length > 0 &&
    bases.every((b) => Math.abs(value.projectedAvgPriceUsd - b) / b > MAX_PRICE_DEVIATION)
  if (implausible) {
    return {
      ok: false,
      reason: `projected price ${value.projectedAvgPriceUsd} is implausible against ${stated.map((b) => b.toFixed(4)).join(' or ')} (or their inverses)`,
    }
  }

  // Venues are display labels: dropping a bad one keeps an otherwise sound
  // proposal in the race. A route id is not a label — it selects the
  // transaction that gets signed, so a wrong one fails the proposal.
  if (ctx.allowedRouteIds !== undefined && ctx.allowedRouteIds.length > 0) {
    if (value.routeId === '') {
      // Routes were offered and none was named. The agent reasoned about them
      // — its text usually names one — but left the field blank, and a
      // proposal with no route cannot be signed. Falling back to the best
      // available keeps the agent selectable, which is the whole promise:
      // whichever agent the user picks, their intent gets filled.
      value.routeId = ctx.allowedRouteIds[0] as string
    } else if (!ctx.allowedRouteIds.includes(value.routeId)) {
      // Naming a route that does not exist is different: the agent chose
      // something specific and chose wrong, and substituting silently would
      // sign a trade it did not pick.
      return { ok: false, reason: `route ${value.routeId} was not offered` }
    }
  }

  // A split is two actions in one transaction, so it needs both halves to be
  // meaningful: a price to rest the remainder at, and a genuine division.
  if (value.executionMode === 'split') {
    if (value.restPriceUsd <= 0) {
      return { ok: false, reason: 'a split plan needs a resting price for the remainder' }
    }
    if (value.splitPct <= 0 || value.splitPct >= 100) {
      // Entirely one side is not a split — it is a fill or a rest, and
      // accepting it here would let an agent claim a plan it did not make.
      return {
        ok: false,
        reason: `split of ${value.splitPct}% is not a split: use fill or rest instead`,
      }
    }
  }

  const allowed = new Set(ctx.allowedVenueIds)
  const venues = value.venues.filter((v) => allowed.has(v))

  return {
    ok: true,
    value: {
      ...value,
      reasoning: value.reasoning.slice(0, MAX_REASONING_CHARS),
      venues: venues.length > 0 ? venues : ctx.allowedVenueIds.slice(0, 1),
    },
  }
}

/**
 * How far inside the market an agent may propose resting.
 *
 * An agent choosing to rest is exercising judgement worth respecting. An agent
 * choosing to rest at a price nothing will ever reach is not a strategy, it is
 * a way to never trade. The band keeps a proposed order within reach of the
 * book it has to fill against, while leaving room for a genuinely patient one.
 */
export const MAX_REST_IMPROVEMENT = 0.25

export interface ExecutionPlanRequest {
  mode: 'fill' | 'rest'
  /** What the agent proposed, in USD per unit bought. */
  agentPriceUsd: number
  /**
   * The price the user actually typed, when they typed one.
   *
   * Takes precedence over anything the agent says. A limit price is the one
   * part of an intent that must survive contact with a language model exactly
   * as written.
   */
  statedLimitPriceUsd: number | undefined
  /** The asset being given up, which decides the side of the book to read. */
  selling: ClassicAsset
  book: OrderBookTop
}

export type ExecutionPlan =
  | {
      ok: true
      mode: 'fill' | 'rest'
      /** Absent when filling now. */
      restPriceUsd?: number
      /** Whose number this is, so the UI can say. */
      priceSource?: 'user' | 'agent'
      /** True when the agent's price was pulled back toward the market. */
      clamped?: boolean
      marketPriceUsd?: number
    }
  | {
      ok: false
      reason: 'would_fill_now' | 'no_market' | 'invalid_price'
      detail?: string
    }

/**
 * Settles what an agent's proposal actually does.
 *
 * The agent decides *whether* to wait. It does not get the final say on the
 * price it waits at, because that number decides whether the order ever fills
 * and it was produced by a model reading free text. Three rules, in order:
 *
 * 1. A price the user stated wins outright.
 * 2. An unstated price is clamped toward the market, so no proposal rests
 *    somewhere unreachable.
 * 3. Either way, a price that would cross the spread is refused — an order
 *    that fills the instant it is placed is a market order with a misleading
 *    label, which is the behaviour this whole path exists to prevent.
 */
export function resolveExecutionPlan(req: ExecutionPlanRequest): ExecutionPlan {
  const { mode, agentPriceUsd, statedLimitPriceUsd, selling, book } = req

  // Filling now needs no price: the network prices it at inclusion, and the
  // slippage floor on the operation is what protects the fill.
  if (mode === 'fill') return { ok: true, mode: 'fill' }

  const sellingBase = selling.issuer === undefined
  const reference = sellingBase ? book.bid : book.ask

  if (reference === undefined) {
    return {
      ok: false,
      reason: 'no_market',
      detail: 'Nothing is quoted for this pair, so there is no price to rest against.',
    }
  }

  // Rule 1. The user's price is not the agent's to move.
  if (statedLimitPriceUsd !== undefined) {
    if (wouldCrossSpread({ selling, price: statedLimitPriceUsd, book })) {
      // Refused rather than adjusted. Nudging it would fill at a price the
      // user did not choose, which is worse than declining.
      return {
        ok: false,
        reason: 'would_fill_now',
        detail: `The market is already at ${reference}, so an order at ${statedLimitPriceUsd} would trade immediately.`,
      }
    }
    return {
      ok: true,
      mode: 'rest',
      restPriceUsd: statedLimitPriceUsd,
      priceSource: 'user',
      marketPriceUsd: reference,
    }
  }

  if (!Number.isFinite(agentPriceUsd) || agentPriceUsd <= 0) {
    return { ok: false, reason: 'invalid_price', detail: 'A resting price must be above zero.' }
  }

  // Rule 3, checked before clamping: an agent asking to cross is making a
  // different decision than it claims, and that is a rejection rather than a
  // number to adjust.
  if (wouldCrossSpread({ selling, price: agentPriceUsd, book })) {
    return {
      ok: false,
      reason: 'would_fill_now',
      detail: `An order at ${agentPriceUsd} would trade immediately against a market at ${reference}.`,
    }
  }

  // Rule 2. Buying rests below the ask, so the furthest allowed is the ask
  // discounted by the band; selling rests above the bid, so it is the bid
  // marked up by it.
  const limit = sellingBase
    ? reference * (1 + MAX_REST_IMPROVEMENT)
    : reference * (1 - MAX_REST_IMPROVEMENT)

  const tooFar = sellingBase ? agentPriceUsd > limit : agentPriceUsd < limit

  return {
    ok: true,
    mode: 'rest',
    restPriceUsd: tooFar ? limit : agentPriceUsd,
    priceSource: 'agent',
    ...(tooFar ? { clamped: true } : {}),
    marketPriceUsd: reference,
  }
}
