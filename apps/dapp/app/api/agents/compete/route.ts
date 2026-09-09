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
import { parseIntent } from '../../../../lib/parse-intent'
import { toBaseUnits } from '../../../../lib/swap/assets'

/**
 * Runs one competition and streams each agent's proposal as it lands.
 *
 * Server-side because the provider API key lives here and must never reach the
 * browser. POST rather than GET so the user's intent text stays out of URLs and
 * access logs.
 *
 * Node runtime: `node:crypto` and the provider client are not edge-safe.
 */
/** Limit orders refuse to trade through their price; market orders do not. */
function isLimitOrder(type: string): boolean {
  return type === 'limit_buy' || type === 'limit_sell'
}

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
      isLimitOrder(intent.input.type) && intent.targetPriceUsd > 0
        ? {
            minReceive: toBaseUnits(
              (Number(intent.input.amountIn) * intent.targetPriceUsd).toFixed(7)
            ),
          }
        : {}
    )
    if (routes.length > 0) market.routes = routes
  } catch {
    // Leaving routes unset is the honest outcome; agents reason without them.
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
              send({
                type: 'competition:proposal',
                competitionId,
                proposal: outcome.proposal,
                ...(own !== undefined ? { route: own.quote } : {}),
                degraded: outcome.meta.degraded,
              })
              return outcome.proposal
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
