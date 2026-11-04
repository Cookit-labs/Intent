import { describe, expect, it, vi } from 'vitest'

import {
  chainFigures,
  chainRequestFor,
  chainReviewClosed,
  raceClosed,
  stepErrorMessage,
  chainSigning,
  isChainRoute,
  needsDirectRoute,
  recommendationLine,
  reviewChainRoute,
  routeForSwap,
  routeFigures,
  routeSource,
  selectionHolds,
  showDirectNote,
  singleRouteNote,
} from '../agents/chain-race'
import type { ChainRouteQuote } from '../agents/chain-routes'
import { describePlan } from '../agents/competition'
import type { ChainActionRequest } from '../chains/types'

const asked: ChainActionRequest = { kind: 'swap', amount: '5', tokenIn: 'NEAR', tokenOut: 'USDC' }

const tagged = (source: string | undefined): { source?: string } =>
  source === undefined ? {} : { source }

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

  it('may replace a built, unsigned card with another venue', () => {
    const args = { ...base(), phase: 'review' as const, preparedVenueId: 'other' }
    expect(reviewChainRoute(args)).toBe('prepared')
    expect(args.prepare).toHaveBeenCalledTimes(1)
  })

  it('builds nothing for the venue already on the card, so its deposit address stays', () => {
    const args = { ...base(), phase: 'review' as const, preparedVenueId: 'ref' }
    expect(reviewChainRoute(args)).toBe('ignored')
    expect(args.prepare).not.toHaveBeenCalled()
    expect(args.refuse).not.toHaveBeenCalled()
  })

  it('builds again for the same venue once the card has failed', () => {
    const args = { ...base(), phase: 'failed' as const, preparedVenueId: 'ref' }
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

describe('routeForSwap', () => {
  it('keeps every chain route away from the Stellar swap hook', () => {
    expect(routeForSwap(route())).toBeUndefined()
    expect(routeForSwap({ kind: 'chain' })).toBeUndefined()
    expect(isChainRoute({ kind: 'chain', venueId: 5 })).toBe(true)
  })

  it('passes a Stellar quote and nothing through unchanged', () => {
    const stellar = { id: 'x', sendAmount: '5000000' }
    expect(routeForSwap(stellar)).toBe(stellar)
    expect(routeForSwap(undefined)).toBeUndefined()
  })
})

describe('chain card phases', () => {
  it('closes Review once a signature is out, given, or the outcome is unknown', () => {
    expect(chainReviewClosed('signing', false)).toBe(true)
    expect(chainReviewClosed('submitting', false)).toBe(true)
    expect(chainReviewClosed('settled', false)).toBe(true)
    expect(chainReviewClosed('pending', false)).toBe(true)
    expect(chainReviewClosed('failed', true)).toBe(true)
    expect(chainReviewClosed('review', false)).toBe(false)
    expect(chainReviewClosed('failed', false)).toBe(false)
    expect(chainReviewClosed('idle', false)).toBe(false)
  })

  it('knows when a signature is in flight', () => {
    expect(chainSigning('signing')).toBe(true)
    expect(chainSigning('submitting')).toBe(true)
    expect(chainSigning('review')).toBe(false)
  })

  it('shows the direct-route note only while nothing is signed', () => {
    expect(showDirectNote(true, 'building')).toBe(true)
    expect(showDirectNote(true, 'review')).toBe(true)
    for (const p of ['idle', 'signing', 'submitting', 'settled', 'pending', 'failed'] as const) {
      expect(showDirectNote(true, p)).toBe(false)
    }
    expect(showDirectNote(false, 'review')).toBe(false)
  })

  it('never says nothing was signed above step 2, once the swap settled', () => {
    expect(showDirectNote(true, 'review', false)).toBe(true)
    expect(showDirectNote(true, 'review', true)).toBe(false)
    expect(showDirectNote(true, 'building', true)).toBe(false)
  })

  it('drops the selected look after a failed or empty card', () => {
    expect(selectionHolds('failed')).toBe(false)
    expect(selectionHolds('idle')).toBe(false)
    expect(selectionHolds('building')).toBe(true)
    expect(selectionHolds('review')).toBe(true)
    expect(selectionHolds('settled')).toBe(true)
  })
})

describe('raceClosed', () => {
  it('closes on a signature, and on a settled sequence even with the latch lifted', () => {
    expect(raceClosed(false, false)).toBe(false)
    expect(raceClosed(true, false)).toBe(true)
    expect(raceClosed(false, true)).toBe(true)
    expect(raceClosed(true, true)).toBe(true)
  })

  it('keeps the panel locked on step 2’s card, whose latch step 2’s press has lifted', () => {
    expect(chainReviewClosed('review', raceClosed(false, true))).toBe(true)
    expect(chainReviewClosed('idle', raceClosed(false, true))).toBe(true)
    expect(chainReviewClosed('failed', raceClosed(false, true))).toBe(true)
  })

  it('builds no second swap when Review is pressed on the race after step 1 settled', () => {
    const prepare = vi.fn()
    const refuse = vi.fn()
    for (const phase of ['review', 'idle', 'failed'] as const) {
      expect(
        reviewChainRoute({
          route: {
            kind: 'chain',
            venueId: 'jupiter',
            request: { kind: 'swap', amount: '0.5', tokenIn: 'SOL', tokenOut: 'USDC' },
          },
          asked: { kind: 'swap', amount: '0.5', tokenIn: 'SOL', tokenOut: 'USDC' },
          text: 'swap 0.5 SOL to USDC then send to x',
          phase,
          signed: raceClosed(false, true),
          prepare,
          refuse,
        })
      ).toBe('ignored')
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(refuse).not.toHaveBeenCalled()
  })
})

describe('stepErrorMessage', () => {
  const STEP = 'This step did not start. The swap stands, and what arrived stays in your wallet.'

  it('leaves a message alone until the swap has settled', () => {
    const said = 'Too much. Nothing was signed or sent.'
    expect(stepErrorMessage(said, false)).toBe(said)
    expect(stepErrorMessage(undefined, true)).toBeUndefined()
  })

  it('replaces the claim once the swap has been signed', () => {
    expect(stepErrorMessage('Too much. Nothing was signed or sent.', true)).toBe(
      `Too much. ${STEP}`
    )
    expect(stepErrorMessage('A venue is busy, so nothing was signed or sent.', true)).toBe(
      `A venue is busy. ${STEP}`
    )
    expect(
      stepErrorMessage('Not answering. Nothing was signed or sent, so try again in a moment.', true)
    ).toBe(`Not answering. ${STEP}`)
  })

  it('reads correctly whatever "so try again" follows the claim', () => {
    expect(
      stepErrorMessage(
        'Kamino is busy right now. Nothing was signed or sent, so try again in a few seconds.',
        true
      )
    ).toBe(`Kamino is busy right now. ${STEP}`)
    expect(stepErrorMessage('Busy, so nothing was signed or sent, so try again soon.', true)).toBe(
      `Busy. ${STEP}`
    )
    expect(stepErrorMessage('Not ready. Nothing was signed or sent, so try again', true)).toBe(
      `Not ready. ${STEP}`
    )
  })

  it('leaves a message that makes no such claim', () => {
    expect(stepErrorMessage('Could not reach the network.', true)).toBe(
      'Could not reach the network.'
    )
  })
})

describe('reviewChainRoute after a signature', () => {
  const args = (over: object) => ({
    route: route(),
    asked,
    text: 't',
    phase: 'failed' as const,
    prepare: vi.fn(),
    refuse: vi.fn(),
    ...over,
  })

  it('stays closed after a failure that followed a signature', () => {
    const a = args({ signed: true })
    expect(reviewChainRoute(a)).toBe('ignored')
    expect(a.prepare).not.toHaveBeenCalled()
  })

  it('reopens after a failure before any signature', () => {
    expect(reviewChainRoute(args({ signed: false }))).toBe('prepared')
  })

  it('does not wipe a built card for an agent that chose no route', () => {
    const a = args({ route: undefined, phase: 'review' })
    expect(reviewChainRoute(a)).toBe('ignored')
    expect(a.refuse).not.toHaveBeenCalled()
  })

  it('says the agent chose no route when there is no card to protect', () => {
    const a = args({ route: undefined, phase: 'idle' })
    expect(reviewChainRoute(a)).toBe('refused')
    expect(a.refuse).toHaveBeenCalledWith(expect.stringContaining("didn't choose a route"), 't')
  })
})

describe('routeSource', () => {
  it('names the venue of a chain route, which the plan tag then shows', () => {
    const jupiter = routeSource(route({ venueName: 'Jupiter' }))
    const oneClick = routeSource(route({ venueName: 'NEAR Intents 1Click' }))
    expect(describePlan({ executionMode: 'fill', ...tagged(jupiter) })).toBe(
      'fills now via Jupiter'
    )
    expect(describePlan({ executionMode: 'fill', ...tagged(oneClick) })).toBe(
      'fills now via NEAR Intents 1Click'
    )
  })

  it('keeps the source of a Stellar quote', () => {
    expect(routeSource({ id: 'x', source: 'SDEX' })).toBe('SDEX')
  })

  it('has nothing to say with no route', () => {
    expect(routeSource(undefined)).toBeUndefined()
    expect(routeSource({ source: 5 })).toBeUndefined()
  })
})

describe('recommendationLine', () => {
  it('says what Stellar and a priced swap always said', () => {
    expect(recommendationLine('Halcyon', undefined)).toBe(
      'Recommended: Halcyon, best measured fill. You pick who executes.'
    )
  })

  it('gives a supply or a stake its rate, and claims no fill', () => {
    expect(recommendationLine('Halcyon', { headline: '5.20% APY' })).toBe(
      'Recommended: Halcyon, 5.20% APY. You pick who executes.'
    )
    expect(recommendationLine('Halcyon', { headline: 'Rate not available' })).toBe(
      'Recommended: Halcyon, rate not available. You pick who executes.'
    )
  })

  it('claims no measured fill for a swap nobody could price', () => {
    expect(recommendationLine('Halcyon', { headline: 'Price unknown' })).toBe(
      'Recommended: Halcyon, price unknown. You pick who executes.'
    )
  })
})

describe('routeFigures', () => {
  it('shows an unknown price or rate for a chain proposal with no route', () => {
    expect(routeFigures(undefined, asked)).toEqual({ headline: 'Price unknown' })
    expect(routeFigures(undefined, { kind: 'supply', amount: '1', tokenIn: 'USDC' })).toEqual({
      headline: 'Rate not available',
    })
  })

  it('changes nothing for Stellar, which asks for no chain request', () => {
    expect(routeFigures(undefined, undefined)).toBeUndefined()
    expect(routeFigures({ id: 'x' }, undefined)).toBeUndefined()
  })

  it('formats the rate to two places', () => {
    const supply: ChainActionRequest = { kind: 'supply', amount: '5', tokenIn: 'USDC' }
    expect(chainFigures(route({ apyPercent: 4.2 }, supply))).toEqual({ headline: '4.20% APY' })
  })
})
