import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

import type { AgentProposalResult, AgentStrategyKey } from '../../../../lib/agents/brain'
import { ALL_STRATEGIES } from '../../../../lib/agents/brain'
import type { CompetitionFrame } from '../../../../lib/agents/events'
import { encodeFrame } from '../../../../lib/agents/events'
import { buildMarketContextAsync, quoteRoutes } from '../../../../lib/agents/market-context'
import { measureRoute } from '../../../../lib/agents/measure'
import { getAgentBrains } from '../../../../lib/agents/registry'
import { pickWinner, scoreProposals, unanimousChoice } from '../../../../lib/agents/scoring'
import { STRATEGIES, STRATEGY_ORDER } from '../../../../lib/agents/strategies'
import { isLimitType } from '../../../../lib/intent-kind'
import { parseIntent } from '../../../../lib/parse-intent'
import { resolveAsset, toBaseUnits } from '../../../../lib/swap/assets'
import { fetchOrderBookTop } from '../../../../lib/swap/limit-price'
import type { OrderBookTop } from '../../../../lib/swap/limit-price'
import type { SwapQuote } from '../../../../lib/swap/quote'
import { resolveExecutionPlan } from '../../../../lib/agents/tool-schema'
import type { ParsedIntent } from '../../../../lib/parse-intent'

/**
 * Runs one competition and streams each agent's proposal as it lands.
 *
 * Server-side because the provider API key lives here and must never reach the
 * browser. POST rather than GET so the user's intent text stays out of URLs and
 * access logs.
 *
 * **There is no fallback.** A brain that is not configured, a chain that
 * cannot execute, or a race in which nobody answers all end in a
 * `competition:error` frame that says so. Canned proposals used to fill those
 * gaps, and they read as strategy — venues from another chain, prices from
 * another asset — right up until the user tried to act on one.
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
 * routinely takes 20-40s on a real request — measured, not guessed.
 */
const AGENT_TIMEOUT_MS = 60_000

const WINDOW_SECONDS = 30

/**
 * Chains a competition can execute on.
 *
 * Checked before anything runs, and by name. The chain used to default to
 * 'arc' when the body carried none, and an unrecognised slug fell through to
 * the EVM venue list — so a stale client could start a Stellar competition in
 * which the agents were offered Uniswap. Now a missing or unsupported chain is
 * an answer the user reads, not a race that quietly runs on the wrong facts.
 */
const EXECUTING_CHAINS: Record<string, string> = {
  stellar: 'Stellar',
}

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
 * throw away a real route over a number this function can correct.
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

/**
 * Replaces the agent's self-reported figures with ones measured from the
 * route it chose.
 *
 * The agent's numbers survive validation as a plausibility check and no
 * further. What the user sees and what scoring ranks is the quote's real
 * output against the oracle's fair value — a claim of 0.1% slippage is not
 * evidence of 0.1% slippage.
 */
function measured(
  proposal: AgentProposalResult,
  quote: SwapQuote | undefined,
  prices: Record<string, number>
): AgentProposalResult {
  if (quote === undefined) return proposal
  const m = measureRoute(quote, prices)
  if (m === undefined) return proposal
  return {
    ...proposal,
    projectedAvgPriceUsd: Number(m.avgPriceUsd.toFixed(6)),
    projectedSlippagePct: Number(m.vsOraclePct.toFixed(2)),
  }
}

/** One SSE stream carrying a single error frame, then closing. */
function errorStream(code: 'agents_offline' | 'chain_unsupported', message: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeFrame({ type: 'competition:error', code, message })))
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

export async function POST(request: Request): Promise<Response> {
  let text: string
  let chain: string

  try {
    const body = (await request.json()) as { text?: unknown; chain?: unknown }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return NextResponse.json({ error: 'invalid_text' }, { status: 400 })
    }
    text = body.text.trim().slice(0, MAX_INTENT_CHARS)
    chain = typeof body.chain === 'string' ? body.chain.trim() : ''
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  // Chain first. Everything below — prices, venues, routes, the book — is
  // chain-specific, and an agent reasoning about the wrong chain is not a
  // worse answer but a wrong one.
  if (chain === '') {
    return errorStream(
      'chain_unsupported',
      'No chain was named for this intent. Reload the app and try again.'
    )
  }
  if (EXECUTING_CHAINS[chain] === undefined) {
    return errorStream(
      'chain_unsupported',
      `Agents can execute only on ${Object.values(EXECUTING_CHAINS).join(', ')} right now. ` +
        `Switch the chain to run a competition.`
    )
  }

  const brains = getAgentBrains()
  if (brains === undefined) {
    return errorStream(
      'agents_offline',
      'The agents are not online right now, so nothing was proposed. Nothing can be executed until they are.'
    )
  }

  const competitionId = randomUUID()
  // Prices are fetched first so the parser can size "$30 of XLM" against the
  // real market rather than an indicative table.
  const market = await buildMarketContextAsync(chain)
  const intent = parseIntent(text, market.prices)

  // Priced before the agents run, so they choose between real routes rather
  // than describing hypothetical ones. Failing to quote is not fatal: the
  // competition proceeds without executable routes and says so.
  try {
    const routes = await quoteRoutes(
      chain,
      intent.input.tokenIn,
      intent.input.tokenOut,
      toBaseUnits(intent.input.amountIn),
      undefined,
      // A limit order states a price it will not trade through, expressed as
      // a minimum output so the quoter can decline. Keyed on `limitPriceUsd`
      // rather than `targetPriceUsd`: the latter falls back to spot when the
      // user named no price, and a limit derived from the market is not one.
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
  const from = resolveAsset(intent.input.tokenIn)
  const to = resolveAsset(intent.input.tokenOut)
  if (from !== undefined && to !== undefined) {
    const base = from.issuer === undefined ? from : to
    const counter = from.issuer === undefined ? to : from
    try {
      book = await fetchOrderBookTop(base, counter)
    } catch {
      book = undefined
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
        // The model is named up front, while the card still says "thinking".
        // Four agents on three models is the answer to "why does the same one
        // always win", and it only answers it if the user can see it.
        agents: STRATEGY_ORDER.map((key) => ({
          key,
          name: STRATEGIES[key].name,
          gradient: STRATEGIES[key].gradient,
          model: brains[key].model,
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
            const outcome = await brains[strategy].propose({
              intent,
              strategy,
              market,
              chain,
              signal: controllerForAgent.signal,
            })

            if (!outcome.ok) {
              // Said, and left empty. No placeholder: an agent that did not
              // answer has no proposal, and showing one would be inventing it.
              send({ type: 'competition:failed', competitionId, strategy, error: outcome.error })
              return undefined
            }

            // This agent's own route, so executing it signs what it proposed
            // rather than what the winner proposed.
            const own = (market.routes ?? []).find((r) => r.id === outcome.proposal.routeId)

            const proposal = measured(
              settlePlan(outcome.proposal, intent, book),
              own?.quote as SwapQuote | undefined,
              market.prices
            )

            send({
              type: 'competition:proposal',
              competitionId,
              proposal,
              ...(own !== undefined ? { route: own.quote } : {}),
            })
            return proposal
          } finally {
            clearTimeout(timer)
          }
        })
      )

      const proposals = settled.filter((p): p is AgentProposalResult => p !== undefined)

      if (proposals.length === 0) {
        send({
          type: 'competition:error',
          code: 'no_agent_answered',
          message:
            'None of the agents answered this time. Nothing was proposed. Try again in a moment.',
        })
        closed = true
        controller.close()
        return
      }

      const scored = scoreProposals(proposals, { competitionId })
      const winner = pickWinner(scored)

      if (winner !== null) {
        const winningProposal = proposals.find((p) => p.strategy === winner)
        const chosen = (market.routes ?? []).find((r) => r.id === winningProposal?.routeId)

        // Agreement, named as such. When every agent that could execute chose
        // the same route and the same plan, the "winner" was drawn by hash
        // among equals — and saying "Recommended: Halcyon" over that reads as
        // a judgement nobody made.
        const unanimous = unanimousChoice(scored)

        send({
          type: 'competition:winner',
          competitionId,
          winner,
          scores: Object.fromEntries(scored.map((s) => [s.strategy, s.score])),
          unanimous,
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
