import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MarketContext, ProposalRequest } from '../agents/brain'
import { createBrain } from '../agents/brains/openai-compatible'
import { SYSTEM_PROMPT } from '../agents/brief'
import { buildMarketContext, fetchLendingRates } from '../agents/market-context'
import { SUBMIT_PROPOSAL_TOOL, validateProposal } from '../agents/tool-schema'
import type { Env } from '../lend/defindex/config'
import type { Reserve } from '../lend/reserves'
import { parseIntent } from '../parse-intent'

/**
 * A second lending venue, all the way from the market context to the
 * validated proposal.
 *
 * What is being pinned: the agents are told every configured venue's rate,
 * in one line each that names the venue, the asset, the APY and that it is a
 * testnet figure; they may name any configured venue in `thenVenue` and have
 * it validated exactly as Blend is; and none of that exists on a deployment
 * without the DeFindex key, where nothing about the competition changes.
 */

const WITH_KEY = { DEFINDEX_API_KEY: 'sk_test' }
const WITHOUT_KEY = { DEFINDEX_API_KEY: '' }

const blendReserve = { supplyApy: 4.123, utilisation: 0.9 } as Reserve

describe('fetchLendingRates', () => {
  it('reads Blend alone when DeFindex is not configured', async () => {
    let asked = 0
    const rates = await fetchLendingRates({
      env: WITHOUT_KEY,
      readBlend: () => Promise.resolve(blendReserve),
      readDefindex: () => {
        asked += 1
        return Promise.resolve({ vault: 'C', apy: 19.4 })
      },
    })

    expect(rates).toEqual([{ venue: 'blend', asset: 'XLM', supplyApy: 4.12, utilisation: 90 }])
    expect(asked).toBe(0)
  })

  it('adds every DeFindex vault that has a rate when the key is set', async () => {
    const rates = await fetchLendingRates({
      env: WITH_KEY,
      readBlend: () => Promise.resolve(blendReserve),
      // XLM has a vault; USDC's holds a different asset and is declined.
      readDefindex: (symbol) =>
        Promise.resolve(symbol === 'XLM' ? { vault: 'C', apy: 19.4 } : undefined),
    })

    expect(rates).toEqual([
      { venue: 'blend', asset: 'XLM', supplyApy: 4.12, utilisation: 90 },
      {
        venue: 'defindex',
        asset: 'XLM',
        supplyApy: 19.4,
        basis: '7-day trailing, net of vault fees',
      },
    ])
  })

  it('keeps DeFindex when Blend cannot be read', async () => {
    const rates = await fetchLendingRates({
      env: WITH_KEY,
      readBlend: () => Promise.reject(new Error('rpc down')),
      readDefindex: (symbol) =>
        Promise.resolve(symbol === 'XLM' ? { vault: 'C', apy: 19.4 } : undefined),
    })

    expect(rates.map((r) => r.venue)).toEqual(['defindex'])
  })

  it('keeps Blend when DeFindex cannot be read', async () => {
    // Silent, like every other feed here: a competition should not collapse
    // because one lending venue was unreachable.
    const rates = await fetchLendingRates({
      env: WITH_KEY,
      readBlend: () => Promise.resolve(blendReserve),
      readDefindex: () => Promise.reject(new Error('403')),
    })

    expect(rates.map((r) => r.venue)).toEqual(['blend'])
  })
})

describe('buildMarketContext', () => {
  it('offers DeFindex as a venue only when it is configured', () => {
    const ids = (env: Env) => buildMarketContext('stellar', env).venues.map((v) => v.id)

    expect(ids(WITHOUT_KEY)).toContain('blend')
    expect(ids(WITHOUT_KEY)).not.toContain('defindex')
    expect(ids(WITH_KEY)).toContain('defindex')
  })
})

const market: MarketContext = {
  asOf: new Date().toISOString(),
  prices: { XLM: 0.18, USDC: 1 },
  venues: [{ id: 'soroswap', name: 'Soroswap', category: 'swap' }],
  volatilityHint: 'normal',
  gasHint: 'cheap',
}

const request: ProposalRequest = {
  intent: parseIntent('Swap 20 USDC to XLM'),
  agent: 'groq:qwen/qwen3.8-27b',
  seat: 0,
  market,
  chain: 'stellar',
}

interface Captured {
  body: { messages: { role: string; content: string }[] }
}

function capture(into: Captured[], reply: unknown): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    into.push({ body: JSON.parse(String(init.body)) as Captured['body'] })
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as unknown as typeof fetch
}

const NO_TOOL_CALL = { choices: [{ message: {} }] }

function toolCall(overrides: Record<string, unknown>): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: 'submit_proposal',
                arguments: JSON.stringify({
                  routeId: '',
                  reasoning: 'Fill now, then supply.',
                  projectedAvgPriceUsd: request.intent.referencePriceUsd,
                  projectedSlippagePct: 0.1,
                  venues: ['soroswap'],
                  sliceCount: 1,
                  confidence: 0.6,
                  horizonMinutes: 1,
                  executionMode: 'fill',
                  restPriceUsd: 0,
                  splitPct: 0,
                  thenAction: 'none',
                  thenVenue: '',
                  ...overrides,
                }),
              },
            },
          ],
        },
      },
    ],
  }
}

describe('the lending line in the prompt', () => {
  it('names each venue, its asset, its APY, and that the figure is from testnet', async () => {
    const seen: Captured[] = []
    await createBrain({
      apiKey: 'k',
      fetchImpl: capture(seen, NO_TOOL_CALL),
    }).propose({
      ...request,
      market: {
        ...market,
        lending: [
          { venue: 'blend', asset: 'XLM', supplyApy: 4.12, utilisation: 90 },
          {
            venue: 'defindex',
            asset: 'XLM',
            supplyApy: 19.4,
            basis: '7-day trailing, net of vault fees',
          },
        ],
      },
    })

    const context = seen[0]?.body.messages[1]?.content ?? ''
    expect(context).toContain('Lending venues, with live supply rates (testnet figures')
    expect(context).toContain('blend: XLM at 4.12% APY, 90% utilised')
    expect(context).toContain('defindex: XLM at 19.4% APY (7-day trailing, net of vault fees)')
  })

  it('says nothing about lending when no rate was read', async () => {
    const seen: Captured[] = []
    await createBrain({ apiKey: 'k', fetchImpl: capture(seen, NO_TOOL_CALL) }).propose(request)

    expect(seen[0]?.body.messages[1]?.content ?? '').not.toContain('Lending venues')
  })
})

describe('naming DeFindex in thenVenue', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is kept when the deployment is configured for it', async () => {
    vi.stubEnv('DEFINDEX_API_KEY', 'sk_test')
    const outcome = await createBrain({
      apiKey: 'k',
      fetchImpl: capture([], toolCall({ thenAction: 'lend', thenVenue: 'defindex' })),
    }).propose(request)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.proposal.thenAction).toBe('lend')
    expect(outcome.proposal.thenVenue).toBe('defindex')
  })

  it('is downgraded, like any unreachable venue, when it is not', async () => {
    vi.stubEnv('DEFINDEX_API_KEY', '')
    const outcome = await createBrain({
      apiKey: 'k',
      fetchImpl: capture([], toolCall({ thenAction: 'lend', thenVenue: 'defindex' })),
    }).propose(request)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.proposal.thenAction).toBeUndefined()
  })

  it('still keeps Blend either way', async () => {
    vi.stubEnv('DEFINDEX_API_KEY', '')
    const outcome = await createBrain({
      apiKey: 'k',
      fetchImpl: capture([], toolCall({ thenAction: 'lend', thenVenue: 'blend' })),
    }).propose(request)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.proposal.thenVenue).toBe('blend')
  })

  it('is validated exactly as Blend is', () => {
    // Pinned rather than new: `validateProposal` already reads its allowed
    // venues from the context, so a second id needs no second rule.
    const result = validateProposal(
      {
        routeId: '',
        reasoning: 'x',
        projectedAvgPriceUsd: 0.16,
        projectedSlippagePct: 0.2,
        venues: ['soroswap'],
        sliceCount: 1,
        confidence: 0.8,
        horizonMinutes: 5,
        executionMode: 'fill',
        splitPct: 0,
        restPriceUsd: 0,
        thenAction: 'lend',
        thenVenue: 'defindex',
      },
      {
        referencePriceUsd: 0.16,
        allowedVenueIds: ['soroswap'],
        lendingVenueIds: ['blend', 'defindex'],
      }
    )
    expect(result.ok && result.value.thenVenue).toBe('defindex')
  })
})

describe('what the agents are told about where a lend may go', () => {
  it('describes thenVenue by the market context rather than by naming Blend alone', () => {
    const schema = SUBMIT_PROPOSAL_TOOL.function.parameters as {
      properties: { thenVenue: { description: string } }
    }
    expect(schema.properties.thenVenue.description).toContain('defindex')
    expect(schema.properties.thenVenue.description).toMatch(/market context/)
  })

  it('points the brief at the listed venues too', () => {
    expect(SYSTEM_PROMPT).not.toContain('("blend" on Stellar)')
    expect(SYSTEM_PROMPT).toMatch(/lending venues? .*market context/i)
  })
})
