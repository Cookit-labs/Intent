import { describe, expect, it } from 'vitest'

import {
  SUBMIT_PROPOSAL_TOOL,
  validateProposal,
  type ProposalToolInput,
} from '../agents/tool-schema'

/**
 * The vocabulary that lets an agent say what happens after the trade.
 *
 * Two design decisions are being pinned here, and the second is the one that
 * matters most in practice.
 *
 * `thenAction` is a separate field rather than a fourth `executionMode`,
 * because how a trade executes and what follows it are independent: an agent
 * should be able to fill now and then supply, or rest at a price and then
 * supply. A combined enum needs an entry per pairing.
 *
 * And an impossible follow-on **downgrades rather than rejects**. A rejected
 * proposal is replaced by a canned mock, so refusing a sound trade over its
 * optional second step would swap real agent reasoning for fabricated text —
 * which is exactly how every agent came to look hardcoded once already.
 */

const BASE: ProposalToolInput = {
  routeId: 'route-1',
  reasoning: 'Filling now against the deeper book.',
  projectedAvgPriceUsd: 0.16,
  projectedSlippagePct: 0.2,
  venues: ['soroswap'],
  sliceCount: 1,
  confidence: 0.8,
  horizonMinutes: 5,
  executionMode: 'fill',
  splitPct: 0,
  restPriceUsd: 0,
  thenAction: 'none',
  thenVenue: '',
}

const CTX = {
  referencePriceUsd: 0.16,
  allowedVenueIds: ['soroswap'],
  allowedRouteIds: ['route-1'],
  lendingVenueIds: ['blend'],
}

describe('the schema still admits no optional properties', () => {
  it('lists every property as required', () => {
    // The existing guarantee, restated because two properties were just added.
    // Strict tool schemas reject a payload missing any listed property, so a
    // property absent from `required` is a property the model may silently
    // omit — and an omitted follow-on is indistinguishable from "none".
    const schema = SUBMIT_PROPOSAL_TOOL.function.parameters
    const properties = Object.keys(schema.properties)
    for (const name of properties) {
      expect(schema.required, name).toContain(name)
    }
  })

  it('requires the two new properties by name', () => {
    expect(SUBMIT_PROPOSAL_TOOL.function.parameters.required).toContain('thenAction')
    expect(SUBMIT_PROPOSAL_TOOL.function.parameters.required).toContain('thenVenue')
  })

  it('keeps the follow-on independent of how the trade executes', () => {
    // The reason this is a separate field. Were it a fourth executionMode,
    // this pairing could not be expressed at all.
    const restThenLend = validateProposal(
      {
        ...BASE,
        executionMode: 'rest',
        restPriceUsd: 0.15,
        thenAction: 'lend',
        thenVenue: 'blend',
      },
      CTX
    )
    expect(restThenLend.ok).toBe(true)
    if (!restThenLend.ok) return
    expect(restThenLend.value.executionMode).toBe('rest')
    expect(restThenLend.value.thenAction).toBe('lend')
  })
})

describe('a valid follow-on is carried through', () => {
  it('keeps a lend on a chain that has the venue', () => {
    const result = validateProposal({ ...BASE, thenAction: 'lend', thenVenue: 'blend' }, CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.thenAction).toBe('lend')
    expect(result.value.thenVenue).toBe('blend')
  })

  it('leaves an ordinary trade exactly as it was', () => {
    // Every existing proposal path must be untouched by this addition.
    const result = validateProposal(BASE, CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.thenAction).toBe('none')
    expect(result.value.thenVenue).toBe('')
    expect(result.value.executionMode).toBe('fill')
  })
})

describe('an impossible follow-on downgrades rather than failing', () => {
  it('downgrades a venue that is not a lending venue', () => {
    const result = validateProposal({ ...BASE, thenAction: 'lend', thenVenue: 'soroswap' }, CTX)

    // Still ok: the trade is sound, only the extra step was not.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.thenAction).toBe('none')
    expect(result.value.thenVenue).toBe('')
  })

  it('downgrades a lend on a chain with no lending integration', () => {
    // Arc, today.
    const result = validateProposal(
      { ...BASE, thenAction: 'lend', thenVenue: 'blend' },
      { ...CTX, lendingVenueIds: [] }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.thenAction).toBe('none')
  })

  it('downgrades when no lending venues were supplied at all', () => {
    const { lendingVenueIds: _omitted, ...withoutLending } = CTX
    const result = validateProposal(
      { ...BASE, thenAction: 'lend', thenVenue: 'blend' },
      withoutLending
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.thenAction).toBe('none')
  })

  it('keeps the reasoning and the route when downgrading', () => {
    // The whole point of downgrading. Rejecting would discard this and
    // substitute canned text citing venues that do not exist on the chain.
    const result = validateProposal({ ...BASE, thenAction: 'lend', thenVenue: 'aave' }, CTX)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.reasoning).toBe(BASE.reasoning)
    expect(result.value.routeId).toBe('route-1')
  })

  it('still rejects the things that were always rejected', () => {
    // Downgrading must not have become a general amnesty: a route the agent
    // was never offered is still refused, because that one is about to be
    // executed.
    const result = validateProposal({ ...BASE, routeId: 'invented' }, CTX)
    expect(result.ok).toBe(false)
  })
})
