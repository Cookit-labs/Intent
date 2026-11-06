import { describe, expect, it } from 'vitest'

import type { AgentProposalResult, ProposalRequest } from '../agents/brain'
import { buildMessages } from '../agents/brains/openai-compatible'
import { SYSTEM_PROMPT, systemPromptFor } from '../agents/brief'
import {
  chainFigures,
  chainRecommendationLine,
  chainRequestFor,
  reviewChainRoute,
  routeSource,
} from '../agents/chain-race'
import type { ChainRouteQuote } from '../agents/chain-routes'
import { restAlternativeLine, restBand, restOption, restRoute } from '../agents/rest-option'
import { scoreProposals, unanimousChoice } from '../agents/scoring'
import { settleChainPlan } from '../agents/settle-chain-plan'
import type { ChainActionRequest, ChainModule } from '../chains/types'

const sale: ChainActionRequest = { kind: 'swap', amount: '2', tokenIn: 'SOL', tokenOut: 'USDC' }
const buy: ChainActionRequest = { kind: 'swap', amount: '100', tokenIn: 'USDC', tokenOut: 'SOL' }

function chainWith(venues: object[]): ChainModule {
  return { tokens: [], venues } as unknown as ChainModule
}
const limitVenue = {
  id: 'kamino-limit',
  name: 'Kamino',
  kinds: ['limit'],
  limitCost: { amount: '0.003', symbol: 'SOL' },
}
const solana = chainWith([{ id: 'jup', name: 'Jupiter', kinds: ['swap'] }, limitVenue])

describe('restOption', () => {
  it('offers the limit venue for a sale against a stablecoin', () => {
    expect(restOption(solana, sale, 100)).toEqual({
      venueId: 'kamino-limit',
      venueName: 'Kamino',
      marketUsd: 100,
      selling: true,
      cost: { amount: '0.003', symbol: 'SOL' },
      notes: [],
    })
  })

  it('knows a purchase is not a sale', () => {
    expect(restOption(solana, buy, 100)?.selling).toBe(false)
  })

  it('is nothing on a chain with no limit venue', () => {
    expect(
      restOption(chainWith([{ id: 'x', name: 'X', kinds: ['swap'] }]), sale, 100)
    ).toBeUndefined()
  })

  it('is nothing for a supply, a pair with no stablecoin, or a named venue', () => {
    expect(restOption(solana, { kind: 'supply', amount: '1', tokenIn: 'USDC' }, 1)).toBeUndefined()
    expect(restOption(solana, { ...sale, tokenOut: 'JUP' }, 100)).toBeUndefined()
    expect(restOption(solana, { ...sale, venue: 'jupiter' }, 100)).toBeUndefined()
  })

  it('is nothing without a market price', () => {
    expect(restOption(solana, sale, 0)).toBeUndefined()
  })
})

describe('restBand', () => {
  it('sits 0.1% to 5% above the market for a sale', () => {
    const b = restBand(100, true)
    expect(b.least).toBeCloseTo(100.1)
    expect(b.most).toBeCloseTo(105)
  })
  it('sits 0.1% to 5% below the market for a purchase', () => {
    const b = restBand(100, false)
    expect(b.least).toBeCloseTo(99.9)
    expect(b.most).toBeCloseTo(95)
  })
})

function proposal(over: Partial<AgentProposalResult> = {}): AgentProposalResult {
  return {
    agent: 'a',
    routeId: 'jup-1',
    reasoning: 'r',
    projectedAvgPriceUsd: 100,
    projectedSlippagePct: 0.5,
    venues: ['jup'],
    sliceCount: 1,
    confidence: 0.5,
    horizonMinutes: 5,
    executionMode: 'rest',
    restPriceUsd: 102,
    ...over,
  } as AgentProposalResult
}

describe('settleChainPlan with a rest option', () => {
  const rest = restOption(solana, sale, 100)!
  it('keeps a sale resting 2% above the market', () => {
    const s = settleChainPlan(proposal(), rest)
    expect(s.executionMode).toBe('rest')
    expect(s.restPriceUsd).toBe(102)
    expect(s.sliceCount).toBe(1)
  })
  it.each([
    ['below the market', 99],
    ['6% above', 106],
  ])('fills a sale %s', (_n, price) => {
    const s = settleChainPlan(proposal({ restPriceUsd: price }), rest)
    expect(s.executionMode).toBe('fill')
    expect(s.restPriceUsd).toBeUndefined()
  })
  it('fills a purchase above the market and keeps one below it', () => {
    const b = restOption(solana, buy, 100)!
    expect(settleChainPlan(proposal({ restPriceUsd: 101 }), b).executionMode).toBe('fill')
    expect(settleChainPlan(proposal({ restPriceUsd: 98 }), b).executionMode).toBe('rest')
  })
  it('always fills a split', () => {
    const s = settleChainPlan(proposal({ executionMode: 'split', splitPct: 50 }), rest)
    expect(s.executionMode).toBe('fill')
    expect(s.splitPct).toBeUndefined()
  })
  it('always fills without a rest argument', () => {
    expect(settleChainPlan(proposal()).executionMode).toBe('fill')
  })
})

describe('scoring a rest proposal', () => {
  it('never outscores a measured fill, and never makes agents agree', () => {
    const fill = proposal({ agent: 'f', executionMode: 'fill', projectedSlippagePct: 2 })
    const rest = proposal({ agent: 'r', projectedSlippagePct: 0 })
    const scored = scoreProposals([rest, fill], { competitionId: 'c', restsBelowFills: true })
    expect(scored[0]?.agent).toBe('f')
    expect(unanimousChoice(scored)).toBe(false)
  })
})

describe('the recommendation off Stellar', () => {
  it('states one strategy when agents agree', () => {
    expect(
      chainRecommendationLine({ executionMode: 'fill', source: 'Jupiter' }, { agreeing: 2 })
    ).toBe('Recommended: fill now via Jupiter. All 2 agents agree. You pick who executes.')
  })
  it('states one when there is a single route and no agreement to report', () => {
    expect(chainRecommendationLine({ executionMode: 'fill', source: 'Jupiter' })).toBe(
      'Recommended: fill now via Jupiter. You pick who executes.'
    )
  })
  it('names a resting price', () => {
    expect(
      chainRecommendationLine({ executionMode: 'rest', restPriceUsd: 98, source: 'Kamino' })
    ).toBe('Recommended: rest at $98.00 via Kamino. You pick who executes.')
  })
})

describe('restAlternativeLine', () => {
  it('says what resting could cost', () => {
    expect(
      restAlternativeLine([
        {
          executionMode: 'rest',
          restPriceUsd: 98,
          source: 'Kamino',
          restCost: { amount: '0.003', symbol: 'SOL' },
        },
        { executionMode: 'fill', source: 'Jupiter' },
      ])
    ).toBe(
      '1 agent suggests resting at $98.00 through Kamino: it could get more, costs about 0.003 SOL, and may never fill. You choose.'
    )
  })
  it('is nothing when nobody rests or everybody does', () => {
    expect(restAlternativeLine([{ executionMode: 'fill' }])).toBeUndefined()
    expect(restAlternativeLine([{ executionMode: 'rest', restPriceUsd: 98 }])).toBeUndefined()
  })
})

describe('pressing Review on a rest proposal', () => {
  const fillQuote = {
    kind: 'chain',
    request: sale,
    venueId: 'jup',
    venueName: 'Jupiter',
    pay: { amount: '2', symbol: 'SOL' },
  } as ChainRouteQuote
  const rest = restOption(solana, sale, 100)!
  const route = restRoute(fillQuote, rest, 102)

  it('prepares a limit request with the amount and tokens the person gave', () => {
    expect(chainRequestFor(route, sale)).toEqual({
      kind: 'limit',
      amount: '2',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      venue: 'kamino-limit',
      limitPrice: '102',
    })
  })
  it('still refuses a route whose amount differs', () => {
    expect(chainRequestFor(route, { ...sale, amount: '3' })).toBeUndefined()
  })
  it('is shown as resting at that venue', () => {
    expect(routeSource(route)).toBe('Kamino')
    expect(chainFigures(route)).toEqual({ headline: 'Rests at $102.00' })
  })
  it('goes through review as a limit request', () => {
    let seen: ChainActionRequest | undefined
    reviewChainRoute({
      route,
      asked: sale,
      text: 't',
      phase: 'idle',
      prepare: (r) => {
        seen = r
      },
      refuse: () => undefined,
    })
    expect(seen?.kind).toBe('limit')
  })
})

describe('the brief', () => {
  it('names resting only when asked to', () => {
    expect(systemPromptFor('solana')).not.toMatch(/\brest\b/i)
    expect(systemPromptFor('solana', true)).toMatch(/restPriceUsd/)
    expect(systemPromptFor('solana', true)).toMatch(/small/i)
    expect(systemPromptFor('stellar', true)).toBe(SYSTEM_PROMPT)
  })
  it('lists the option in the market context only when there is one', () => {
    const rest = restOption(solana, sale, 100)!
    const req = (withRest: boolean): ProposalRequest =>
      ({
        agent: 'a',
        chain: 'solana',
        intent: {
          outcome: 'x',
          escrowUsd: 200,
          referencePriceUsd: 100,
          targetPriceUsd: 0,
          input: { type: 'market_sell', tokenIn: 'SOL', tokenOut: 'USDC' },
        },
        market: {
          asOf: 'now',
          prices: {},
          venues: [],
          volatilityHint: 'normal',
          gasHint: 'normal',
          ...(withRest ? { rest } : {}),
        },
      }) as unknown as ProposalRequest
    const text = (r: ProposalRequest): string =>
      buildMessages(r)
        .map((m) => m.content)
        .join('\n')
    expect(text(req(true))).toMatch(/Kamino/)
    expect(text(req(true))).toMatch(/0\.003 SOL/)
    expect(text(req(false))).not.toMatch(/Resting option/)
  })
})
