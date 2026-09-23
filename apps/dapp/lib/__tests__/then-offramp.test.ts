import { describe, expect, it } from 'vitest'

import {
  SUBMIT_PROPOSAL_TOOL,
  validateProposal,
  type ProposalToolInput,
} from '../agents/tool-schema'
import { describePlan } from '../agents/competition'
import { buildMarketContext } from '../agents/market-context'

/**
 * The third follow-on. Same rules as lending: independent of executionMode,
 * downgraded rather than rejected when the chain cannot do it, and never
 * carrying an amount.
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
  offrampVenueIds: ['testanchor', 'moneygram'],
}

describe('the schema admits offramp', () => {
  it('lists offramp in the thenAction enum', () => {
    const schema = SUBMIT_PROPOSAL_TOOL.function.parameters as {
      properties: { thenAction: { enum: string[] } }
    }
    expect(schema.properties.thenAction.enum).toEqual(['none', 'lend', 'offramp'])
  })
})

describe('an offramp follow-on', () => {
  it('is carried through when the anchor exists on this chain', () => {
    const r = validateProposal({ ...BASE, thenAction: 'offramp', thenVenue: 'moneygram' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.thenAction).toBe('offramp')
    expect(r.value.thenVenue).toBe('moneygram')
  })

  it('is independent of how the trade executes', () => {
    const r = validateProposal(
      {
        ...BASE,
        executionMode: 'rest',
        restPriceUsd: 0.15,
        thenAction: 'offramp',
        thenVenue: 'testanchor',
      },
      CTX
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.executionMode).toBe('rest')
    expect(r.value.thenAction).toBe('offramp')
  })

  it('downgrades to none on a chain with no anchors', () => {
    const r = validateProposal(
      { ...BASE, thenAction: 'offramp', thenVenue: 'moneygram' },
      { ...CTX, offrampVenueIds: [] }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.thenAction).toBe('none')
    expect(r.value.thenVenue).toBe('')
  })

  it('downgrades when the anchor named is not integrated', () => {
    const r = validateProposal({ ...BASE, thenAction: 'offramp', thenVenue: 'coinbase' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.thenAction).toBe('none')
  })

  it('does not let a lending venue stand in for an anchor', () => {
    const r = validateProposal({ ...BASE, thenAction: 'offramp', thenVenue: 'blend' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.thenAction).toBe('none')
  })
})

describe('buildMarketContext', () => {
  it('keeps anchors out of the swap venue list, but keeps ordinary venues', () => {
    const ctx = buildMarketContext('stellar')
    expect(ctx.venues.every((v) => v.category !== 'offramp')).toBe(true)
    expect(ctx.venues.some((v) => v.id === 'soroswap')).toBe(true)
  })

  it('keeps the perps venue out of the swap venue list too', () => {
    // A proposal naming Noether as its venue would pass validation and then
    // reach a plan builder with no way to open a position. The perp figures
    // travel separately, as facts, under `perps`.
    const ctx = buildMarketContext('stellar')
    expect(ctx.venues.every((v) => v.category !== 'perps')).toBe(true)
  })
})

describe('describePlan', () => {
  it('says where the proceeds go', () => {
    expect(
      describePlan({
        executionMode: 'fill',
        source: 'soroswap',
        thenAction: 'offramp',
        thenVenue: 'moneygram',
      })
    ).toBe('fills now via soroswap · then withdraws to fiat via moneygram')
  })
})
