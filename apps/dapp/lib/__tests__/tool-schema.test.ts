import { describe, expect, it } from 'vitest'

import {
  MAX_SLIPPAGE_PCT,
  SUBMIT_PROPOSAL_TOOL,
  proposalToolSchema,
  validateProposal,
} from '../agents/tool-schema'

/**
 * Structural tests for the tool definition.
 *
 * Strict mode has rules that are easy to break by adding a field and forgetting
 * to list it as required — and the failure arrives as a 400 from the provider
 * at runtime, not at compile time. These catch it locally instead.
 */
describe('submit_proposal tool schema', () => {
  const params = SUBMIT_PROPOSAL_TOOL.function.parameters
  const propertyNames = Object.keys(params.properties)

  it('is marked strict', () => {
    expect(SUBMIT_PROPOSAL_TOOL.function.strict).toBe(true)
  })

  it('forbids additional properties', () => {
    expect(params.additionalProperties).toBe(false)
  })

  it('lists every property as required, as strict mode demands', () => {
    expect([...params.required].sort()).toEqual([...propertyNames].sort())
  })

  it('avoids the keywords strict mode rejects', () => {
    // minLength/maxLength/minItems/maxItems are unsupported; ranges are
    // enforced by the Zod schema after the response arrives instead.
    const serialised = JSON.stringify(params)
    for (const banned of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      expect(serialised).not.toContain(banned)
    }
  })

  it('describes every property, so the model knows what each one means', () => {
    for (const [name, prop] of Object.entries(params.properties)) {
      expect((prop as { description?: string }).description, name).toBeTruthy()
    }
  })

  it('stays in step with the Zod validator', () => {
    // Drift here means the provider accepts a field the app then discards, or
    // the app expects one the provider was never asked for.
    const zodKeys = Object.keys(proposalToolSchema.shape)
    expect(zodKeys.sort()).toEqual([...propertyNames].sort())
  })
})

/**
 * The price guard once rejected every honest proposal.
 *
 * On testnet the route rate and the real market rate differ by roughly 9x, and
 * validating against only one of them failed all four agents. The route then
 * substituted mock proposals, whose slippage figures are hardcoded — so the
 * agent with the lowest hardcoded value won every single competition, and the
 * competition looked rigged rather than broken.
 */
describe('price validation across two bases', () => {
  const ctx = {
    referencePriceUsd: 1.709,
    altReferencePriceUsd: 0.1838,
    allowedVenueIds: ['stellarx'],
  }

  const proposal = (price: number): unknown => ({
    routeId: '',
    reasoning: 'test',
    projectedAvgPriceUsd: price,
    projectedSlippagePct: 0.2,
    venues: ['stellarx'],
    sliceCount: 1,
    confidence: 0.8,
    horizonMinutes: 10,
  })

  it('accepts a price near the route rate', () => {
    expect(validateProposal(proposal(1.7), ctx).ok).toBe(true)
  })

  it('accepts a price near the real market rate', () => {
    // The case that used to fail: quoting the market instead of the route.
    expect(validateProposal(proposal(0.19), ctx).ok).toBe(true)
  })

  it('still rejects a price near neither', () => {
    const out = validateProposal(proposal(45), ctx)
    expect(out.ok).toBe(false)
  })

  it('falls back to the single basis when no alternative is given', () => {
    const single = { referencePriceUsd: 0.1838, allowedVenueIds: ['stellarx'] }
    expect(validateProposal(proposal(0.19), single).ok).toBe(true)
    expect(validateProposal(proposal(1.709), single).ok).toBe(false)
  })

  it('publishes the slippage bound it enforces', () => {
    // Rejecting a value for exceeding an unstated limit reads as the model
    // failing when the contract was incomplete.
    const slip = SUBMIT_PROPOSAL_TOOL.function.parameters.properties['projectedSlippagePct'] as {
      maximum?: number
    }
    expect(slip.maximum).toBe(MAX_SLIPPAGE_PCT)
  })
})

/**
 * A rate has a direction; "average fill price" does not carry one.
 *
 * Buying XLM with USDC, agents quote ~1.72 USDC per XLM while both references
 * describe the same trade as ~0.18 XLM per USDC. The guard compared a rate
 * against its own reciprocal and rejected all four agents, dropping the
 * competition to canned mock proposals — which carry no route, so nothing
 * could be signed at all.
 */
describe('price validation accepts either direction of a rate', () => {
  const ctx = {
    referencePriceUsd: 0.1053,
    altReferencePriceUsd: 0.1807,
    allowedVenueIds: ['stellarx'],
  }

  const proposal = (price: number): unknown => ({
    routeId: '',
    reasoning: 'test',
    projectedAvgPriceUsd: price,
    projectedSlippagePct: 0.2,
    venues: ['stellarx'],
    sliceCount: 1,
    confidence: 0.8,
    horizonMinutes: 10,
  })

  it('accepts the inverted rate that was being rejected', () => {
    // 1 / 0.1807 is about 5.53; the observed rejection was 1.7163 against
    // these same bases, which is 1 / 0.5826 — inside tolerance of 1 / 0.1053.
    expect(validateProposal(proposal(1 / 0.1053), ctx).ok).toBe(true)
  })

  it('still accepts a rate stated the same way round as the reference', () => {
    expect(validateProposal(proposal(0.18), ctx).ok).toBe(true)
  })

  it('still rejects a figure near neither direction', () => {
    expect(validateProposal(proposal(4200), ctx).ok).toBe(false)
  })
})
