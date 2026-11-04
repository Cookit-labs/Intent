import { describe, expect, it } from 'vitest'

import type { AgentProposalResult, ProposalRequest } from '../agents/brain'
import { buildMessages } from '../agents/brains/openai-compatible'
import { SYSTEM_PROMPT, systemPromptFor } from '../agents/brief'
import { quoteChainRoutes, type ChainRouteQuote } from '../agents/chain-routes'
import { buildMarketContext } from '../agents/market-context'
import { measureChainRoute } from '../agents/measure'
import { planPenalties, planScore } from '../agents/plan-scoring'
import { pickWinner, scoreProposals } from '../agents/scoring'
import { applyChainMeasure, isUnmeasuredSwap, settleChainPlan } from '../agents/settle-chain-plan'
import type { ChainActionRequest, ChainModule, ChainToken } from '../chains/types'

const swap: ChainActionRequest = { kind: 'swap', amount: '100', tokenIn: 'AAA', tokenOut: 'OUT' }

function quoteOf(over: Partial<ChainRouteQuote>): ChainRouteQuote {
  return {
    kind: 'chain',
    request: swap,
    venueId: 'v',
    venueName: 'V',
    pay: { amount: '100', symbol: 'AAA' },
    valueInUsd: 5,
    ...over,
  }
}

describe('the prompt an agent on another chain is given', () => {
  const prompt = systemPromptFor('near')

  it.each(['testnet', 'anchor', 'rest', 'split'])('never mentions %s', (word) => {
    expect(prompt).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'))
  })

  it('says the funds are real and the fill is single', () => {
    expect(prompt).toMatch(/mainnet/i)
    expect(prompt).toMatch(/real funds/i)
  })

  it('is exactly the existing prompt on Stellar', () => {
    expect(systemPromptFor('stellar')).toBe(SYSTEM_PROMPT)
  })
})

describe('measuring a chain route', () => {
  it('ranks $4.97 out above $4.74 out whatever each token’s decimals', async () => {
    const decimals = [6, 9, 18, 24]
    const outs = [
      { amount: '4.970000', price: 1 },
      { amount: '2.485', price: 2 },
      { amount: '4.74', price: 1 },
      { amount: '0.948', price: 5 },
    ]
    const tokens: ChainToken[] = [
      { symbol: 'AAA', id: 'a', decimals: 7 },
      ...decimals.map((d, i) => ({ symbol: `T${i}`, id: `t${i}`, decimals: d })),
    ]
    const prices: Record<string, number> = { AAA: 0.05, T0: 1, T1: 2, T2: 1, T3: 5 }
    const chainApi = {
      tokens,
      defaultVenue: {},
      priceUsd: async (t: ChainToken) => prices[t.symbol],
      venues: outs.map((o, i) => ({
        id: `v${i}`,
        name: `V${i}`,
        kinds: ['swap'],
        quote: async () => ({ receive: { amount: o.amount, symbol: `T${i}` } }),
      })),
    } as unknown as ChainModule

    const routes = await quoteChainRoutes(chainApi, swap, 'acct')
    const usd = routes.map((r) => measureChainRoute(r.quote as ChainRouteQuote)?.outUsd)
    expect(usd[0]).toBeCloseTo(4.97, 6)
    expect(usd[1]).toBeCloseTo(4.97, 6)
    expect(usd[2]).toBeCloseTo(4.74, 6)
    expect(usd[3]).toBeCloseTo(4.74, 6)
    expect(usd[0] as number).toBeGreaterThan(usd[2] as number)
  })

  it('takes the venue’s own dollar value over a computed one', () => {
    const m = measureChainRoute(
      quoteOf({ valueOutUsd: 4.5, receive: { amount: '9', symbol: 'X' } })
    )
    expect(m?.outUsd).toBe(4.5)
    expect(m?.vsInPct).toBeCloseTo(10, 6)
  })

  it('is undefined for a swap it cannot price, not zero', () => {
    expect(measureChainRoute(quoteOf({ receive: { amount: '9', symbol: 'X' } }))).toBeUndefined()
    const { valueInUsd: _unpriced, ...noValueIn } = quoteOf({ valueOutUsd: 4 })
    expect(measureChainRoute(noValueIn)).toBeUndefined()
  })

  it('does not charge a stake or a supply for slippage it cannot have', () => {
    const stake = quoteOf({
      request: { kind: 'stake', amount: '100', tokenIn: 'AAA' },
      apyPercent: 4,
      receive: { amount: '97', symbol: 'stAAA' },
    })
    expect(measureChainRoute(stake)).toEqual({ outUsd: 5, vsInPct: 0 })
  })
})

describe('settling a chain plan', () => {
  it('forces fill and no follow-on, whatever the agent chose', () => {
    const proposal = {
      agent: 'halcyon',
      reasoning: 'x',
      projectedAvgPriceUsd: 1,
      projectedSlippagePct: 0,
      venues: [],
      sliceCount: 3,
      confidence: 0.5,
      horizonMinutes: 5,
      executionMode: 'rest',
      restPriceUsd: 4,
      splitPct: 40,
      thenAction: 'lend',
      thenVenue: 'kamino',
    } as unknown as AgentProposalResult
    const settled = settleChainPlan(proposal)
    expect(settled.executionMode).toBe('fill')
    expect(settled.thenAction).toBeUndefined()
    expect(settled.thenVenue).toBeUndefined()
    expect(settled.restPriceUsd).toBeUndefined()
    expect(settled.splitPct).toBeUndefined()
    expect(settled.sliceCount).toBe(1)
  })
})

describe('the market an agent on Solana is given', () => {
  const market = buildMarketContext('solana')

  it('offers only venues the app executes on', async () => {
    const { venues } = await import('../venues')
    const executes = new Set(venues.filter((v) => v.integration === 'executes').map((v) => v.id))
    expect(market.venues.length).toBeGreaterThan(0)
    for (const v of market.venues) expect(executes.has(v.id)).toBe(true)
  })

  it('carries no Stellar tokens or prices', () => {
    expect(market.assets ?? []).toEqual([])
    expect(market.prices).toEqual({})
  })
})

describe('the routes as an agent reads them', () => {
  function requestFor(routes: ProposalRequest['market']['routes']): ProposalRequest {
    return {
      agent: 'halcyon',
      seat: 0,
      chain: 'near',
      intent: {
        outcome: 'stake 100 NEAR',
        escrowUsd: 400,
        referencePriceUsd: 4,
        targetPriceUsd: 4,
        input: {
          type: 'market_sell',
          tokenIn: 'NEAR',
          tokenOut: 'NEAR',
          amountIn: '100',
          minAmountOut: '0',
          deadline: '2026-11-04T00:00:00.000Z',
        },
      },
      market: {
        asOf: '2026-11-04T00:00:00.000Z',
        prices: { NEAR: 4 },
        venues: [{ id: 'meta', name: 'Meta Pool', category: 'staking' }],
        volatilityHint: 'normal',
        gasHint: 'normal',
        ...(routes !== undefined ? { routes } : {}),
      },
    } as ProposalRequest
  }

  const stakeRoute = {
    id: 'meta-1',
    source: 'Meta Pool',
    sendAmount: '100',
    receiveAmount: '',
    hops: 1,
    executable: true,
    quote: quoteOf({
      request: { kind: 'stake', amount: '100', tokenIn: 'NEAR' },
      pay: { amount: '100', symbol: 'NEAR' },
      apyPercent: 6.2,
    }),
  }

  it('shows a stake by its rate and never as a blank receive', () => {
    const text = buildMessages(requestFor([stakeRoute]))
      .map((m) => m.content)
      .join('\n')
    expect(text).toContain('6.2% APY')
    expect(text).toContain('send 100 NEAR')
    expect(text).not.toMatch(/receive\s*(on|$)/m)
    expect(text).not.toMatch(/->\s*receive\s+on/)
  })

  it('does not call the chain a testnet', () => {
    const text = buildMessages(requestFor([stakeRoute]))
      .map((m) => m.content)
      .join('\n')
    expect(text).not.toMatch(/testnet/i)
  })

  it('leaves the Stellar prompt as it was', () => {
    const req = { ...requestFor(undefined), chain: 'stellar' }
    const first = buildMessages(req)[0]
    expect(first?.content).toBe(SYSTEM_PROMPT)
  })
})

describe('ranking deposits and stakes by rate', () => {
  const base = {
    agent: 'halcyon',
    reasoning: 'x',
    projectedAvgPriceUsd: 1,
    projectedSlippagePct: 0,
    venues: [],
    sliceCount: 1,
    confidence: 0.5,
    horizonMinutes: 5,
    executionMode: 'fill',
  } as unknown as AgentProposalResult
  const plan = {
    escrowUsd: 400,
    referencePriceUsd: 4,
    askedToLend: false,
    askedToOfframp: false,
    apyByRoute: { 'a-1': 6.2, 'b-1': 4.1 },
  }

  it('scores the lower rate below the higher one', () => {
    const high = planScore({ ...base, routeId: 'a-1' }, plan)
    const low = planScore({ ...base, routeId: 'b-1' }, plan)
    expect(high).toBe(100)
    expect(low).toBeCloseTo(97.9, 1)
  })

  it('says why in the penalty', () => {
    const [p] = planPenalties({ ...base, routeId: 'b-1' }, plan)
    expect(p?.reason).toBe('lower_rate')
    expect(p?.detail).toContain('4.1%')
    expect(p?.detail).toContain('6.2%')
  })

  it('leaves a swap race, which has no rates, untouched', () => {
    const { apyByRoute: _ignored, ...swapPlan } = plan
    expect(planPenalties({ ...base, routeId: 'b-1' }, swapPlan)).toEqual([])
  })

  it('puts a route with no rate below the worst route with one', () => {
    const rated = planScore({ ...base, routeId: 'b-1' }, plan)
    const unrated = planScore({ ...base, routeId: 'kamino-1' }, plan)
    expect(unrated).toBeLessThan(rated)
    expect(planPenalties({ ...base, routeId: 'kamino-1' }, plan)[0]?.reason).toBe('unrated_route')
  })

  it('never lets a route with no rate be crowned over one that shows a rate', () => {
    // Several races, because a tie would be broken by a hash of the race's id.
    const winners = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
      (competitionId) =>
        scoreProposals(
          [
            { ...base, agent: 'halcyon', routeId: 'kamino-1' },
            { ...base, agent: 'meridian', routeId: 'a-1' },
          ] as AgentProposalResult[],
          { competitionId, plan }
        )[0]?.agent
    )
    expect(new Set(winners)).toEqual(new Set(['meridian']))
  })

  it('keeps that order however far apart the rates are', () => {
    const wide = { ...plan, apyByRoute: { 'a-1': 250, 'b-1': 4.1 } }
    const rated = planScore({ ...base, routeId: 'b-1' }, wide)
    const unrated = planScore({ ...base, routeId: 'kamino-1' }, wide)
    expect(unrated).toBeLessThan(rated)
  })

  it('leaves the routes level when none of them has a rate', () => {
    const { apyByRoute: _ignored, ...noRates } = plan
    expect(planScore({ ...base, routeId: 'kamino-1' }, noRates)).toBe(100)
    expect(planPenalties({ ...base, routeId: 'kamino-1' }, noRates)).toEqual([])
    expect(planPenalties({ ...base, routeId: 'kamino-1' }, { ...plan, apyByRoute: {} })).toEqual([])
  })
})

describe('what the panel is shown for a chain route', () => {
  const claim = {
    agent: 'halcyon',
    routeId: 'v-1',
    reasoning: 'x',
    projectedAvgPriceUsd: 20.1,
    projectedSlippagePct: 0,
    venues: [],
    sliceCount: 1,
    confidence: 0.5,
    horizonMinutes: 5,
    executionMode: 'fill',
  } as unknown as AgentProposalResult

  it('replaces a token ratio with the dollars paid per unit received', () => {
    const q = quoteOf({ valueOutUsd: 4.97, receive: { amount: '4.97', symbol: 'USDC' } })
    const shown = applyChainMeasure(claim, q)
    expect(shown.projectedAvgPriceUsd).toBeCloseTo(5 / 4.97, 6)
    expect(shown.projectedSlippagePct).toBeCloseTo(0.6, 2)
  })

  it('shows the price of the token paid in for a stake', () => {
    const q = quoteOf({ request: { kind: 'stake', amount: '100', tokenIn: 'AAA' }, apyPercent: 5 })
    const shown = applyChainMeasure(claim, q)
    expect(shown.projectedAvgPriceUsd).toBeCloseTo(0.05, 6)
    expect(shown.projectedSlippagePct).toBe(0)
  })

  it('claims nothing for a swap it cannot price', () => {
    const q = quoteOf({ receive: { amount: '4.97', symbol: 'USDC' } })
    const shown = applyChainMeasure({ ...claim, projectedSlippagePct: 4 }, q)
    expect(shown.projectedAvgPriceUsd).toBe(0)
    expect(shown.projectedSlippagePct).toBe(0)
  })
})

describe('a swap route that could not be priced', () => {
  const agent = (key: string, routeId: string, slippage: number): AgentProposalResult =>
    ({
      agent: key,
      routeId,
      reasoning: 'x',
      projectedAvgPriceUsd: 1,
      projectedSlippagePct: slippage,
      venues: [],
      sliceCount: 1,
      confidence: 0.5,
      horizonMinutes: 5,
      executionMode: 'fill',
    }) as unknown as AgentProposalResult
  const plan = {
    escrowUsd: 5,
    referencePriceUsd: 0.05,
    askedToLend: false,
    askedToOfframp: false,
    unmeasuredRoutes: ['unpriced-1'],
  }

  it('is a swap with no dollar value out', () => {
    expect(isUnmeasuredSwap(quoteOf({ receive: { amount: '4', symbol: 'X' } }))).toBe(true)
    expect(isUnmeasuredSwap(quoteOf({ valueOutUsd: 4 }))).toBe(false)
  })

  it('loses to a priced route that really lost value', () => {
    const scored = scoreProposals(
      [agent('halcyon', 'unpriced-1', 0), agent('meridian', 'priced-1', 3)],
      { competitionId: 'c', plan }
    )
    expect(scored[0]?.agent).toBe('meridian')
    expect(scored[1]?.penalties[0]?.reason).toBe('unpriced_route')
  })

  it('still picks a winner when every route is unpriced', () => {
    const all = { ...plan, unmeasuredRoutes: ['unpriced-1', 'unpriced-2'] }
    const scored = scoreProposals(
      [agent('halcyon', 'unpriced-1', 0), agent('meridian', 'unpriced-2', 0)],
      { competitionId: 'c', plan: all }
    )
    expect(scored).toHaveLength(2)
    expect(pickWinner(scored)).not.toBeNull()
  })
})
