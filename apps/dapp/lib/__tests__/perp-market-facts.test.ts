import { describe, expect, it } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { createBrain } from '../agents/brains/openai-compatible'
import { parseIntent } from '../parse-intent'
import type { NoetherClient } from '../perps/noether-client'
import { readPerpFacts } from '../perps/market-facts'

/**
 * Noether's live figures as facts for the agents.
 *
 * Supplied for the same reason lending rates are: a model asked to recall a
 * perp market's open interest will invent one. Failure is silent — a
 * competition should not collapse because a perps gateway was unreachable —
 * and the prompt says plainly that a perp cannot be a plan step yet, so an
 * agent reads the figures without being tempted to propose one.
 */

function client(over: Partial<NoetherClient> = {}): NoetherClient {
  const base: NoetherClient = {
    readHealth: async () => ({
      version: '0.0.0-dev',
      network: 'testnet',
      contracts: { market: 'CM', router: 'CR', vault: 'CV', usdcToken: 'CU' },
      paused: false,
    }),
    readMarkets: async () => [
      {
        asset: 'XLM',
        name: 'Stellar Lumens',
        decimals: 7,
        markPrice: '2129103',
        markPriceUsd: 0.2129103,
        priceTimestamp: 1,
      },
      {
        asset: 'BTC',
        name: 'Bitcoin',
        decimals: 8,
        markPrice: '854269022222',
        markPriceUsd: 85426.9,
        priceTimestamp: 1,
      },
    ],
    readStats: async () => [
      {
        asset: 'XLM',
        openInterestLong: '252541116930',
        openInterestShort: '400000000000',
        openPositions: 5,
        volume24h: '150000000000',
      },
    ],
    readVaults: async () => [{ id: 0, name: 'bigbig', totalUsdc: '11000000000', apyBps: 250 }],
    betaStatus: async () => ({ gated: true, allowed: false }),
    requestChallenge: async () => ({ challengeHex: '', expiresAt: 0 }),
    exchangeChallenge: async () => ({ keyId: '', secret: '' }),
    prepareOpen: async () => ({ op: '', trader: '', xdr: '' }),
    submit: async () => ({ hash: '', status: 'FAILED' }),
  }
  return { ...base, ...over }
}

describe('readPerpFacts', () => {
  it('joins price, open interest and vault APY per market, in USD', async () => {
    const facts = await readPerpFacts(client())
    expect(facts).toEqual({
      venue: 'noether',
      version: '0.0.0-dev',
      vaultApyPct: 2.5,
      markets: [
        {
          asset: 'XLM',
          markPriceUsd: 0.2129103,
          openInterestLongUsd: 25254.11,
          openInterestShortUsd: 40000,
          openPositions: 5,
        },
        // No stats row: the price still stands, the open interest is unknown.
        { asset: 'BTC', markPriceUsd: 85426.9 },
      ],
    })
  })

  it('returns nothing when the venue is offline', async () => {
    const facts = await readPerpFacts(
      client({
        readHealth: async () => {
          throw new Error('offline')
        },
      })
    )
    expect(facts).toBeUndefined()
  })

  it('returns nothing when the market is paused', async () => {
    // A paused market accepts no opens. Figures from it would tempt an agent
    // to reason about a venue no intent can reach right now.
    const facts = await readPerpFacts(
      client({
        readHealth: async () => ({
          version: '0.0.0-dev',
          network: 'testnet',
          contracts: { market: 'CM', router: 'CR', vault: 'CV', usdcToken: 'CU' },
          paused: true,
        }),
      })
    )
    expect(facts).toBeUndefined()
  })

  it('keeps the prices when only the stats read fails', async () => {
    const facts = await readPerpFacts(
      client({
        readStats: async () => {
          throw new Error('stats down')
        },
      })
    )
    expect(facts?.markets.map((m) => m.asset)).toEqual(['XLM', 'BTC'])
    expect(facts?.markets[0]?.openInterestLongUsd).toBeUndefined()
  })

  it('leaves the vault APY out when no vault reports one', async () => {
    const facts = await readPerpFacts(client({ readVaults: async () => [] }))
    expect(facts?.vaultApyPct).toBeUndefined()
  })
})

describe('the perp facts in the agent prompt', () => {
  const market: MarketContext = {
    asOf: '2026-09-23T00:00:00.000Z',
    prices: { XLM: 0.21, USDC: 1 },
    venues: [{ id: 'noether', name: 'Noether', category: 'perps' }],
    volatilityHint: 'normal',
    gasHint: 'normal',
    perps: {
      venue: 'noether',
      version: '0.0.0-dev',
      vaultApyPct: 2.5,
      markets: [
        {
          asset: 'XLM',
          markPriceUsd: 0.2129103,
          openInterestLongUsd: 25254.11,
          openInterestShortUsd: 40000,
          openPositions: 5,
        },
      ],
    },
  }

  const request: ProposalRequest = {
    intent: parseIntent('Buy $20 of XLM'),
    agent: 'deepseek:deepseek-v4-flash',
    seat: 0,
    market,
    chain: 'stellar',
  }

  async function promptSentBy(req: ProposalRequest): Promise<string> {
    let body = ''
    const brain = createBrain({
      apiKey: 'sk-test',
      fetchImpl: (async (_: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body)
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    await brain.propose(req)
    const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] }
    return parsed.messages.map((m) => m.content).join('\n')
  }

  it('states the figures and that a perp cannot be proposed as a step', async () => {
    const prompt = await promptSentBy(request)
    expect(prompt).toMatch(/Noether/)
    expect(prompt).toMatch(
      /XLM: mark \$0\.2129103, open interest long \$25,254\.11 \/ short \$40,000, 5 open positions/
    )
    expect(prompt).toMatch(/vault APY 2\.5%/)
    expect(prompt).toMatch(/cannot be proposed as a plan step/i)
    // Measured facts about the venue, not marketing: unaudited, dev-tagged.
    expect(prompt).toMatch(/unaudited/)
    expect(prompt).toMatch(/0\.0\.0-dev/)
    // The gateway exposes no funding rate; said rather than left to memory.
    expect(prompt).toMatch(/no funding rate/i)
  })

  it('says nothing about perps when the facts are absent', async () => {
    const { perps: _omitted, ...withoutPerps } = market
    const prompt = await promptSentBy({ ...request, market: withoutPerps })
    expect(prompt).not.toMatch(/Perpetual futures/)
    expect(prompt).not.toMatch(/cannot be proposed as a plan step/)
  })
})
