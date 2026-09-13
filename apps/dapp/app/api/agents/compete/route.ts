import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

import type { AgentProposalResult, AgentStrategyKey } from '../../../../lib/agents/brain'
import { ALL_STRATEGIES } from '../../../../lib/agents/brain'
import type { CompetitionFrame } from '../../../../lib/agents/events'
import { encodeFrame } from '../../../../lib/agents/events'
import { buildMarketContextAsync, quoteRoutes } from '../../../../lib/agents/market-context'
import { buildMockProposal } from '../../../../lib/agents/brains/mock-brain'
import { getAgentBrain } from '../../../../lib/agents/registry'
import { isBuyIntent, pickWinner, scoreProposals } from '../../../../lib/agents/scoring'
import { STRATEGIES, STRATEGY_ORDER } from '../../../../lib/agents/strategies'
import { isLimitType } from '../../../../lib/intent-kind'
import { parseIntent } from '../../../../lib/parse-intent'
import { resolveAsset, toBaseUnits } from '../../../../lib/swap/assets'
import { fetchOrderBookTop } from '../../../../lib/swap/limit-price'
import type { OrderBookTop } from '../../../../lib/swap/limit-price'
import { resolveExecutionPlan } from '../../../../lib/agents/tool-schema'
import type { ParsedIntent } from '../../../../lib/parse-intent'

/**
 * Runs one competition and streams each agent's proposal as it lands.
 *
 * Server-side because the provider API key lives here and must never reach the
 * browser. POST rather than GET so the user's intent text stays out of URLs and
 * access logs.
 *
 * Node runtime: `node:crypto` and the provider client are not edge-safe.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Bounds prompt size and the cost of a single request. */
const MAX_INTENT_CHARS = 500

/**
 * Per-agent ceiling. Four of these run concurrently, not in sequence.
 *
 * Generous because DeepSeek reasons in thinking mode before answering, which
 * routinely takes 20-40s on a real request — measured, not guessed. A tighter
 * bound simply aborted every agent and served the offline fallback, which
 * looked like the model failing rather than the timeout being wrong.
 */
const AGENT_TIMEOUT_MS = 60_000

const WINDOW_SECONDS = 30

/**
 * Settles what an agent's proposal actually does, against the live book.
 *
 * Runs server-side so a resting price is bounded before it ever reaches the
 * browser. The agent's judgement about *whether* to wait is kept; the price it
 * waits at is not taken on trust, because that number decides whether the order
 * ever fills and a language model produced it from free text.
 *
 * A plan that cannot rest becomes a fill rather than a rejection. The agent
 * reasoned soundly about everything else, and dropping the whole proposal would
 * substitute a mock that carries no route and cannot be signed — the failure
 * that once made a single agent appear to win every competition.
 */
function settlePlan(
  proposal: AgentProposalResult,
  intent: ParsedIntent,
  book: OrderBookTop | undefined
): AgentProposalResult {
  if (proposal.executionMode !== 'rest') return proposal

  // Omitting the key rather than setting it undefined: `exactOptionalPropertyTypes`
  // treats the two as different, and a fill has no resting price at all.
  const { restPriceUsd: _dropped, ...filling } = proposal
  const asFill: AgentProposalResult = { ...filling, executionMode: 'fill' }

  const selling = resolveAsset(intent.input.tokenIn)
  if (selling === undefined || book === undefined) return asFill

  const plan = resolveExecutionPlan({
    mode: 'rest',
    agentPriceUsd: proposal.restPriceUsd ?? 0,
    statedLimitPriceUsd: intent.limitPriceUsd,
    selling,
    book,
  })

  if (!plan.ok || plan.restPriceUsd === undefined) return asFill

  return { ...proposal, executionMode: 'rest', restPriceUsd: plan.restPriceUsd }
}

export async function POST(request: Request): Promise<Response> {
  let text: string
  let chain: string

  try {
    const body = (await request.json()) as { text?: unknown; chain?: unknown }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return NextResponse.json({ error: 'invalid_text' }, { status: 400 })
    }
    text = body.text.trim().slice(0, MAX_INTENT_CHARS)
    chain = typeof body.chain === 'string' ? body.chain : 'arc'
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const competitionId = randomUUID()
  // Prices are fetched first so the parser can size "$30 of XLM" against the
  // real market. The built-in table drifts badly — it valued XLM at $0.58
  // against a market near $0.19 — and sizing from it spends a third of what
  // the user asked for.
  const market = await buildMarketContextAsync(chain)
  const intent = parseIntent(text, market.prices)
  const brain = getAgentBrain()

  // Priced before the agents run, so they choose between real routes rather
  // than describing hypothetical ones. Failing to quote is not fatal: the
  // competition proceeds without executable routes and says so.
  try {
    const routes = await quoteRoutes(
      chain,
      intent.input.tokenIn,
      intent.input.tokenOut,
      // The parsed input quantity, which for a swap is what actually leaves
      // the account. Deriving it from the USD figure instead would re-introduce
      // the rounding the parser just resolved.
      toBaseUnits(intent.input.amountIn),
      undefined,
      // A limit order states a price it will not trade through. Expressed as a
      // minimum output so the quoter can decline: sell 100 XLM at $0.25 means
      // at least 25 USDC must come back, and anything less is not the trade
      // that was asked for.
      //
      // Keyed on `limitPriceUsd` rather than `targetPriceUsd`: the latter falls
      // back to spot when the user named no price, so the old `> 0` test passed
      // for every intent and floored unpriced orders at the current market —
      // a limit derived from the market is not a limit.
      isLimitType(intent.input.type) && intent.limitPriceUsd !== undefined
        ? {
            minReceive: toBaseUnits(
              (Number(intent.input.amountIn) * intent.limitPriceUsd).toFixed(7)
            ),
          }
        : {}
    )
    if (routes.length > 0) market.routes = routes
  } catch {
    // Leaving routes unset is the honest outcome; agents reason without them.
  }

  // One read for the whole competition: every agent's resting price is checked
  // against the same book, so four proposals are judged on identical facts.
  let book: OrderBookTop | undefined
  if (chain === 'stellar') {
    const from = resolveAsset(intent.input.tokenIn)
    const to = resolveAsset(intent.input.tokenOut)
    if (from !== undefined && to !== undefined) {
      // Quoted in one orientation regardless of trade direction, because that
      // is the orientation the prices are expressed in.
      const base = from.issuer === undefined ? from : to
      const counter = from.issuer === undefined ? to : from
      try {
        book = await fetchOrderBookTop(base, counter)
      } catch {
        // Without a book nothing can rest, and `settlePlan` turns every
        // resting proposal into a fill rather than guessing at a price.
        book = undefined
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let closed = false

      const send = (frame: CompetitionFrame): void => {
        if (closed) return
        controller.enqueue(encoder.encode(encodeFrame(frame)))
      }

      send({
        type: 'competition:started',
        competitionId,
        agents: STRATEGY_ORDER.map((key) => ({
          key,
          name: STRATEGIES[key].name,
          tag: STRATEGIES[key].tag,
          gradient: STRATEGIES[key].gradient,
        })),
        windowSeconds: WINDOW_SECONDS,
      })

      // Agents run concurrently and are emitted as they finish, so one slow
      // agent delays only its own card.
      const settled = await Promise.all(
        ALL_STRATEGIES.map(async (strategy: AgentStrategyKey) => {
          const controllerForAgent = new AbortController()
          const timer = setTimeout(() => controllerForAgent.abort(), AGENT_TIMEOUT_MS)

          try {
            const outcome = await brain.propose({
              intent,
              strategy,
              market,
              chain,
              signal: controllerForAgent.signal,
            })

            if (outcome.ok) {
              // Resolve this agent's own route, so executing it signs what it
              // proposed rather than what the winner proposed.
              const own = (market.routes ?? []).find((r) => r.id === outcome.proposal.routeId)

              // Settle the plan against the live book before it reaches the
              // client. An agent choosing to wait is judgement worth keeping;
              // the price it waits at is bounded, because that number decides
              // whether the order ever fills and a model produced it. A plan
              // that would cross the spread falls back to filling now, which
              // is what it would have done anyway — stated honestly rather
              // than dressed as patience.
              const proposal = settlePlan(outcome.proposal, intent, book)

              send({
                type: 'competition:proposal',
                competitionId,
                proposal,
                ...(own !== undefined ? { route: own.quote } : {}),
                degraded: outcome.meta.degraded,
              })
              return proposal
            }

            // A failed agent falls back to its simulated proposal rather than
            // vanishing: three agents and an empty slot reads as a bug, while
            // four proposals with one marked simulated is honest and complete.
            send({
              type: 'competition:failed',
              competitionId,
              strategy,
              error: outcome.error,
            })
            const fallback = buildMockProposal({ intent, strategy, market, chain })
            send({
              type: 'competition:proposal',
              competitionId,
              proposal: fallback,
              degraded: true,
            })
            return fallback
          } finally {
            clearTimeout(timer)
          }
        })
      )

      const proposals = settled.filter((p): p is AgentProposalResult => p !== undefined)
      const scored = scoreProposals(proposals, { isBuy: isBuyIntent(intent.input.type) })
      const winner = pickWinner(scored)

      if (winner !== null) {
        // The winning agent's chosen route, resolved back to the full quote so
        // the client can build a transaction from it without re-pricing.
        const winningProposal = proposals.find((p) => p.strategy === winner)
        const chosen = (market.routes ?? []).find((r) => r.id === winningProposal?.routeId)

        send({
          type: 'competition:winner',
          competitionId,
          winner,
          scores: Object.fromEntries(scored.map((s) => [s.strategy, s.score])),
          ...(chosen !== undefined ? { route: chosen.quote } : {}),
        })
      }

      closed = true
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
