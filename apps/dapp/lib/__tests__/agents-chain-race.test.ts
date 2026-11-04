import { describe, expect, it, vi } from 'vitest'

import {
  chainFigures,
  chainRequestFor,
  needsDirectRoute,
  reviewChainRoute,
  singleRouteNote,
} from '../agents/chain-race'
import type { ChainRouteQuote } from '../agents/chain-routes'
import type { ChainActionRequest } from '../chains/types'

const asked: ChainActionRequest = { kind: 'swap', amount: '5', tokenIn: 'NEAR', tokenOut: 'USDC' }

function route(over: Partial<ChainRouteQuote> = {}, request: ChainActionRequest = asked) {
  return {
    kind: 'chain',
    request,
    venueId: 'ref',
    venueName: 'Ref',
    pay: { amount: request.amount, symbol: request.tokenIn },
    ...over,
  } as ChainRouteQuote
}

describe('chainRequestFor', () => {
  it('returns the asked request with only the venue set from the route', () => {
    expect(chainRequestFor(route(), { ...asked, venue: 'refin' })).toEqual({
      ...asked,
      venue: 'ref',
    })
  })

  it('refuses a route whose amount differs', () => {
    expect(chainRequestFor(route({}, { ...asked, amount: '6' }), asked)).toBeUndefined()
  })

  it('refuses a route whose tokenIn differs', () => {
    expect(chainRequestFor(route({}, { ...asked, tokenIn: 'USDT' }), asked)).toBeUndefined()
  })

  it('refuses a route whose tokenOut differs', () => {
    expect(chainRequestFor(route({}, { ...asked, tokenOut: 'SCAM' }), asked)).toBeUndefined()
  })

  it('refuses a route whose kind differs', () => {
    expect(chainRequestFor(route({}, { ...asked, kind: 'stake' }), asked)).toBeUndefined()
  })

  it('refuses a Stellar swap quote', () => {
    const stellar = { id: 'x', source: 'SDEX', sendAmount: '5', receiveAmount: '1', path: [] }
    expect(chainRequestFor(stellar, asked)).toBeUndefined()
    expect(chainRequestFor(undefined, asked)).toBeUndefined()
  })

  it('refuses a route with no venue id', () => {
    expect(chainRequestFor(route({ venueId: '' }), asked)).toBeUndefined()
  })
})

describe('singleRouteNote', () => {
  it('says the exact sentence for one route', () => {
    expect(singleRouteNote(1, 'NEAR')).toBe(
      "One route available on NEAR. The agents are judging whether it's worth taking."
    )
  })

  it('says nothing otherwise', () => {
    expect(singleRouteNote(2, 'NEAR')).toBeUndefined()
    expect(singleRouteNote(0, 'NEAR')).toBeUndefined()
    expect(singleRouteNote(undefined, 'NEAR')).toBeUndefined()
  })
})

describe('reviewChainRoute', () => {
  const base = () => ({
    route: route(),
    asked,
    text: 'swap 5 NEAR to USDC',
    phase: 'idle' as const,
    prepare: vi.fn(),
    refuse: vi.fn(),
  })

  it('prepares the asked request with the route venue', () => {
    const args = base()
    expect(reviewChainRoute(args)).toBe('prepared')
    expect(args.prepare).toHaveBeenCalledWith({ ...asked, venue: 'ref' }, args.text)
  })

  it('does nothing while a prepare is under way', () => {
    const args = { ...base(), phase: 'building' as const }
    expect(reviewChainRoute(args)).toBe('ignored')
    expect(args.prepare).not.toHaveBeenCalled()
    expect(args.refuse).not.toHaveBeenCalled()
  })

  it('may replace a built, unsigned card', () => {
    const args = { ...base(), phase: 'review' as const }
    expect(reviewChainRoute(args)).toBe('prepared')
  })

  it.each(['signing', 'submitting', 'settled', 'pending'] as const)(
    'does nothing once %s',
    (phase) => {
      const args = { ...base(), phase }
      expect(reviewChainRoute(args)).toBe('ignored')
      expect(args.prepare).not.toHaveBeenCalled()
    }
  )

  it('refuses in plain words when the route is not what was asked', () => {
    const args = { ...base(), route: route({}, { ...asked, amount: '9' }) }
    expect(reviewChainRoute(args)).toBe('refused')
    expect(args.prepare).not.toHaveBeenCalled()
    expect(args.refuse).toHaveBeenCalledWith(
      expect.stringContaining('Nothing was signed'),
      args.text
    )
  })
})

describe('needsDirectRoute', () => {
  const ended = { phase: 'decided' as const, winner: null, anyAnswered: false }

  it('falls back when the race ends in an offline or unsupported error', () => {
    expect(needsDirectRoute({ ...ended, error: { code: 'agents_offline' } })).toBe(true)
    expect(needsDirectRoute({ ...ended, error: { code: 'chain_unsupported' } })).toBe(true)
    expect(needsDirectRoute({ ...ended, error: { code: 'no_agent_answered' } })).toBe(true)
  })

  it('does not fall back from a refusal the user must read', () => {
    expect(needsDirectRoute({ ...ended, error: { code: 'action_refused' } })).toBe(false)
  })

  it('does not fall back while the race is running or after a winner', () => {
    expect(
      needsDirectRoute({ ...ended, phase: 'competing', error: { code: 'agents_offline' } })
    ).toBe(false)
    expect(needsDirectRoute({ phase: 'decided', winner: 'a', anyAnswered: true })).toBe(false)
  })

  it('falls back when the stream ended with nobody answering and no error', () => {
    expect(needsDirectRoute(ended)).toBe(true)
  })
})

describe('chainFigures', () => {
  it('says the price is unknown for a swap with no measured value', () => {
    expect(chainFigures(route())).toEqual({ headline: 'Price unknown' })
  })

  it('leaves a priced swap to the usual display', () => {
    expect(chainFigures(route({ valueInUsd: 20, valueOutUsd: 19.9 }))).toBeUndefined()
  })

  it('shows the rate for a supply that has one', () => {
    const supply: ChainActionRequest = { kind: 'supply', amount: '5', tokenIn: 'USDC' }
    expect(chainFigures(route({ apyPercent: 4.25 }, supply))).toEqual({ headline: '4.25% APY' })
  })

  it('says the rate is not available otherwise', () => {
    const stake: ChainActionRequest = { kind: 'stake', amount: '5', tokenIn: 'NEAR' }
    expect(chainFigures(route({}, stake))).toEqual({ headline: 'Rate not available' })
  })

  it('does not touch a Stellar route', () => {
    expect(chainFigures({ id: 'x', source: 'SDEX' })).toBeUndefined()
    expect(chainFigures(undefined)).toBeUndefined()
  })
})
