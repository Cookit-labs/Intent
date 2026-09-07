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
          type: 'number',
          description: 'Projected slippage as a percentage, e.g. 0.18 for 0.18%.',
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
  reasoning: z.string().trim().min(1),
  projectedAvgPriceUsd: z.number().finite().positive(),
  projectedSlippagePct: z.number().finite().min(0).max(MAX_SLIPPAGE_PCT),
  venues: z.array(z.string()),
  sliceCount: z.number().int().min(1).max(50),
  confidence: z.number().min(0).max(1),
  horizonMinutes: z.number().int().min(0).max(60 * 24),
})

export type ProposalToolInput = z.infer<typeof proposalToolSchema>

export interface ValidationContext {
  referencePriceUsd: number
  allowedVenueIds: string[]
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
  const deviation =
    Math.abs(value.projectedAvgPriceUsd - ctx.referencePriceUsd) / ctx.referencePriceUsd
  if (ctx.referencePriceUsd > 0 && deviation > MAX_PRICE_DEVIATION) {
    return { ok: false, reason: 'projected price is implausible against the reference' }
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
