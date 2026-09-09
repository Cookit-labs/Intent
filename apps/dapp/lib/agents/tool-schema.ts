import { z } from 'zod'

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
          description: 'Your projected average fill price in USD.',
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
  const bases = [ctx.referencePriceUsd, ctx.altReferencePriceUsd].filter(
    (b): b is number => b !== undefined && b > 0
  )
  const implausible =
    bases.length > 0 &&
    bases.every((b) => Math.abs(value.projectedAvgPriceUsd - b) / b > MAX_PRICE_DEVIATION)
  if (implausible) {
    return {
      ok: false,
      reason: `projected price ${value.projectedAvgPriceUsd} is implausible against ${bases.map((b) => b.toFixed(4)).join(' or ')}`,
    }
  }

  // Venues are display labels: dropping a bad one keeps an otherwise sound
  // proposal in the race. A route id is not a label — it selects the
  // transaction that gets signed, so a wrong one fails the proposal.
  if (ctx.allowedRouteIds !== undefined && value.routeId !== '') {
    if (!ctx.allowedRouteIds.includes(value.routeId)) {
      return { ok: false, reason: `route ${value.routeId} was not offered` }
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
