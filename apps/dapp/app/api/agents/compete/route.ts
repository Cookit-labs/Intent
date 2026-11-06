import { activeNetwork } from '@intent/config'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

import type { AgentProposalResult, MarketContext } from '../../../../lib/agents/brain'
import {
  intentFromChainAction,
  quoteChainRoutes,
  type ChainRouteQuote,
} from '../../../../lib/agents/chain-routes'
import type { CompetitionFrame } from '../../../../lib/agents/events'
import { encodeFrame } from '../../../../lib/agents/events'
import { buildMarketContextAsync, quoteRoutes } from '../../../../lib/agents/market-context'
import { measureRoute } from '../../../../lib/agents/measure'
import { benchedUntilFor, lineUp, noteRateLimited } from '../../../../lib/agents/lineup'
import { getRoster } from '../../../../lib/agents/registry'
import type { PlanContext } from '../../../../lib/agents/plan-scoring'
import { pickWinner, scoreProposals, unanimousChoice } from '../../../../lib/agents/scoring'
import {
  assertValidAmount,
  assertKnownTokens,
  assertNativeReserve,
} from '../../../../lib/chains/prepare'
import { chainModule } from '../../../../lib/chains/registry'
import {
  ChainActionRefused,
  type ChainActionKind,
  type ChainActionRequest,
  type ChainModule,
} from '../../../../lib/chains/types'
import { parseCompoundIntent } from '../../../../lib/parse-compound'
import { isLimitType } from '../../../../lib/intent-kind'
import { buildParsedIntent, parseIntent, type ReadingForIntent } from '../../../../lib/parse-intent'
import { readingFromBody } from '../../../../lib/reading-from-body'
import { resolveAsset, toBaseUnits } from '../../../../lib/swap/assets'
import { ensureLiveAssets, tickersIn } from '../../../../lib/swap/live-assets'
import { fetchOrderBookTop } from '../../../../lib/swap/limit-price'
import type { OrderBookTop } from '../../../../lib/swap/limit-price'
import type { SwapQuote } from '../../../../lib/swap/quote'
import {
  applyChainMeasure,
  isUnmeasuredSwap,
  settleChainPlan,
} from '../../../../lib/agents/settle-chain-plan'
import { resolveExecutionPlan } from '../../../../lib/agents/tool-schema'
import type { ParsedIntent } from '../../../../lib/parse-intent'
import { logRace, type RaceInput } from '../../../../lib/server/analytics'
import { enforceRateLimit } from '../../../../lib/server/rate-limit'

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
 * Chains a competition can execute on: Stellar, and any chain with a module.
 *
 * Checked before anything runs, and by name. The chain used to default to
 * 'arc' when the body carried none, and an unrecognised slug fell through to
 * the EVM venue list — so a stale client could start a Stellar competition in
 * which the agents were offered Uniswap. Now a missing or unsupported chain is
 * an answer the user reads, not a race that quietly runs on the wrong facts.
 */
function canExecuteOn(chain: string): boolean {
  return chain === 'stellar' || chainModule(chain) !== undefined
}

const CHAIN_ACTION_KINDS: readonly ChainActionKind[] = ['swap', 'supply', 'stake']

/** The longest account a chain uses is a 64-character NEAR implicit account; Sui and EVM are shorter. */
const MAX_ACCOUNT_CHARS = 128

/**
 * Reads the structured action from the body, or nothing. Only the shape is
 * checked here; whether the tokens are real is checked against the chain.
 */
function chainActionFromBody(raw: unknown): ChainActionRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { kind, amount, tokenIn, tokenOut, venue } = raw as Record<string, unknown>
  if (typeof kind !== 'string' || !CHAIN_ACTION_KINDS.includes(kind as ChainActionKind)) {
    return undefined
  }
  if (typeof amount !== 'string' || typeof tokenIn !== 'string') return undefined
  return {
    kind: kind as ChainActionKind,
    amount: amount.slice(0, 40),
    tokenIn: tokenIn.slice(0, 40),
    ...(typeof tokenOut === 'string' ? { tokenOut: tokenOut.slice(0, 40) } : {}),
    ...(typeof venue === 'string' ? { venue: venue.slice(0, 40) } : {}),
  }
}

/**
 * What the agents are given for an action on a chain that is not Stellar: the
 * chain's own venues and real quotes, and none of Stellar's prices, assets or
 * order book. Returns the sentence to show instead when there is nothing to race.
 * A `refusal` is the action itself being refused, which the user must read as
 * written; a plain string is a race that could not run, where the direct route
 * is still worth trying.
 */
async function chainRaceFacts(
  chain: string,
  chainApi: ChainModule,
  action: ChainActionRequest,
  account: string | undefined,
  text: string
): Promise<{ intent: ParsedIntent; market: MarketContext } | string | { refusal: string }> {
  // No venue to quote, and none for the direct route to build on, so nothing is worth trying.
  if (!chainApi.venues.some((v) => v.kinds.includes(action.kind))) {
    return {
      refusal: `Nothing here can ${action.kind} on this chain yet, so nothing was signed or sent.`,
    }
  }
  try {
    assertKnownTokens(chainApi, action)
    assertValidAmount(action)
  } catch (e) {
    if (e instanceof ChainActionRefused)
      return { refusal: `${e.message} Nothing was signed or sent.` }
    throw e
  }
  if (account === undefined) {
    return 'No wallet account came with this request, so nothing could be priced. Nothing was signed or sent.'
  }
  try {
    await assertNativeReserve(chainApi, action, account)
  } catch (e) {
    // Worded in full already, ending as every refusal here does.
    if (e instanceof ChainActionRefused) return { refusal: e.message }
    throw e
  }

  const routes = await quoteChainRoutes(chainApi, action, account)
  if (routes.length === 0) {
    return 'No route on this chain could be priced right now, so the agents had nothing to judge. Nothing was signed or sent.'
  }

  const tokenIn = chainApi.tokens.find(
    (t) => t.symbol.toUpperCase() === action.tokenIn.toUpperCase()
  )
  const price =
    tokenIn === undefined ? undefined : await chainApi.priceUsd(tokenIn).catch(() => undefined)

  // The chain's market already leaves out Stellar's assets, prices, lending
  // rates and anchors; see `buildMarketContext`.
  const base = await buildMarketContextAsync(chain)
  const market: MarketContext = {
    ...base,
    prices: price !== undefined && tokenIn !== undefined ? { [tokenIn.symbol]: price } : {},
    venues: chainApi.venues
      .filter((v) => routes.some((r) => r.id === `${v.id}-1`))
      .map((v) => ({
        id: v.id,
        name: v.name,
        category: action.kind === 'swap' ? 'dex' : action.kind === 'supply' ? 'lending' : 'staking',
      })),
    routes,
  }
  return { intent: intentFromChainAction(action, text, price), market }
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
  quote: SwapQuote | ChainRouteQuote | undefined,
  prices: Record<string, number>
): AgentProposalResult {
  if (quote === undefined) return proposal
  if ('kind' in quote && quote.kind === 'chain') return applyChainMeasure(proposal, quote)
  const m = measureRoute(quote, prices)
  if (m === undefined) return proposal
  return {
    ...proposal,
    projectedAvgPriceUsd: Number(m.avgPriceUsd.toFixed(6)),
    projectedSlippagePct: Number(m.vsOraclePct.toFixed(2)),
  }
}

/** One SSE stream carrying a single error frame, then closing. */
function errorStream(
  code: 'agents_offline' | 'chain_unsupported' | 'action_refused',
  message: string
): Response {
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
  // Peeked from a clone, before the real parse and before rate-limiting: a
  // race is costed per caller, and a caller is their wallet when one is
  // connected, not only the IP they may share with everyone else behind the
  // same proxy or campus network. A clone because the body stream can be
  // read only once, and the real parse below still needs it. Anything that
  // fails to read as a string here is silently absent — the malformed body
  // is handled once, in the ordinary parse below, not twice.
  const account = await request
    .clone()
    .json()
    .then((b: unknown) =>
      typeof b === 'object' &&
      b !== null &&
      'account' in b &&
      typeof b.account === 'string' &&
      b.account.length <= MAX_ACCOUNT_CHARS
        ? b.account
        : undefined
    )
    .catch(() => undefined)

  const limited = await enforceRateLimit(request, 'compete', account)
  if (limited !== undefined) return limited

  let text: string
  let chain: string
  let context: string[]
  let reading: ReadingForIntent | undefined
  let chainAction: ChainActionRequest | undefined

  try {
    const body = (await request.json()) as {
      text?: unknown
      chain?: unknown
      context?: unknown
      reading?: unknown
      chainAction?: unknown
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return NextResponse.json({ error: 'invalid_text' }, { status: 400 })
    }
    text = body.text.trim().slice(0, MAX_INTENT_CHARS)
    chain = typeof body.chain === 'string' ? body.chain.trim() : ''
    chainAction = chainActionFromBody(body.chainAction)
    // Stellar's live-asset lookup is for Stellar's tickers; a chain action
    // names its tokens itself and they are checked against the chain's own list.
    if (chain === 'stellar' || chainAction === undefined) await ensureLiveAssets(tickersIn(text))
    reading = readingFromBody(body.reading, text)
    context = Array.isArray(body.context)
      ? body.context.filter((line): line is string => typeof line === 'string').slice(0, 8)
      : []
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
  if (!canExecuteOn(chain)) {
    return errorStream(
      'chain_unsupported',
      'Agents can execute only on Stellar, Solana, Sui, NEAR, Avalanche and Monad right now. ' +
        'Switch the chain to run a competition.'
    )
  }
  if (chain !== 'stellar' && chainAction === undefined) {
    return errorStream(
      'chain_unsupported',
      'This request did not say what to do on this chain, so no race was run. Nothing was signed or sent.'
    )
  }

  const full = getRoster()
  if (full === undefined) {
    return errorStream(
      'agents_offline',
      // Off Stellar the chat builds the direct route next, so something can still be signed.
      chain === 'stellar'
        ? 'The agents are not online right now, so nothing was proposed. Nothing can be executed until they are.'
        : 'The agents are not online right now, so nothing was proposed.'
    )
  }
  const roster = lineUp(full)
  if (roster.length === 0) {
    const back = benchedUntilFor(full)
    const minutes = back !== undefined ? Math.max(1, Math.ceil((back - Date.now()) / 60_000)) : 1
    return errorStream(
      'agents_offline',
      `Every agent has hit its provider's free-tier limit. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
    )
  }

  // Off Stellar the facts come from the chain's own venues and quotes, and a
  // refusal or an unpriceable action ends here, before any agent is called.
  const chainApi = chain === 'stellar' ? undefined : chainModule(chain)
  const chainFacts =
    chainApi !== undefined && chainAction !== undefined
      ? await chainRaceFacts(chain, chainApi, chainAction, account, text)
      : undefined
  if (typeof chainFacts === 'string') return errorStream('chain_unsupported', chainFacts)
  if (chainFacts !== undefined && 'refusal' in chainFacts) {
    return errorStream('action_refused', chainFacts.refusal)
  }

  const competitionId = randomUUID()
  // Taken here, in the request, so the race is recorded for the network it ran on.
  const network = activeNetwork()
  const startedAt = new Date()
  // Prices are fetched first so the parser can size "$30 of XLM" against the
  // real market rather than an indicative table.
  const market = chainFacts?.market ?? (await buildMarketContextAsync(chain))
  // A structured reading, when the chat has one, is what the agents are given.
  // Re-reading the words would lose a paraphrase that no keyword recognises.
  const intent =
    chainFacts?.intent ??
    (reading !== undefined
      ? buildParsedIntent(reading, market.prices)
      : parseIntent(text, market.prices))

  // Priced before the agents run, so they choose between real routes rather
  // than describing hypothetical ones. Failing to quote is not fatal: the
  // competition proceeds without executable routes and says so.
  if (chainFacts === undefined) {
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
  }

  // One read for the whole competition: every agent's resting price is checked
  // against the same book, so four proposals are judged on identical facts.
  let book: OrderBookTop | undefined
  const from = resolveAsset(intent.input.tokenIn)
  const to = resolveAsset(intent.input.tokenOut)
  if (chainFacts === undefined && from !== undefined && to !== undefined) {
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

      // What each agent did, for the analytics log. Only outcomes and timings:
      // nothing an agent wrote and nothing the user typed.
      const attempts: RaceInput['attempts'] = []
      const record = (
        winner: string | null,
        unanimous: boolean | null,
        scores: Record<string, number>
      ): Promise<void> =>
        logRace({
          id: competitionId,
          // Other chains only run on mainnet, and their submits are logged there too.
          network: chain === 'stellar' ? network : 'mainnet',
          chain,
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          intent: {
            type: intent.input.type,
            tokenIn: intent.input.tokenIn,
            tokenOut: intent.input.tokenOut,
            sizeUsd: intent.escrowUsd,
          },
          attempts,
          scores,
          winner,
          unanimous,
        })

      send({
        type: 'competition:started',
        competitionId,
        // The line-up is named up front, while every card still says
        // "thinking". Each agent is a model, and the user can see which.
        agents: roster.map(({ key, name, gradient, model }) => ({ key, name, gradient, model })),
        windowSeconds: WINDOW_SECONDS,
        ...(chainFacts !== undefined ? { routeCount: market.routes?.length ?? 0 } : {}),
      })

      // Agents run concurrently and are emitted as they finish, so one slow
      // agent delays only its own card.
      const settled = await Promise.all(
        roster.map(async (agent, seat) => {
          const began = Date.now()
          const controllerForAgent = new AbortController()
          const timer = setTimeout(() => controllerForAgent.abort(), AGENT_TIMEOUT_MS)

          try {
            const outcome = await agent.brain.propose({
              intent,
              agent: agent.key,
              seat,
              market,
              chain,
              ...(context.length > 0 ? { context } : {}),
              signal: controllerForAgent.signal,
            })

            if (!outcome.ok) {
              if (outcome.error === 'rate_limited') {
                noteRateLimited(agent.key, outcome.retryAfterMs)
              }
              attempts.push({
                agent: agent.key,
                model: agent.model,
                ok: false,
                latencyMs: Date.now() - began,
                error: outcome.error,
              })
              // Said, and left empty. No placeholder: an agent that did not
              // answer has no proposal, and showing one would be inventing it.
              send({
                type: 'competition:failed',
                competitionId,
                agent: agent.key,
                error: outcome.error,
              })
              return undefined
            }

            // This agent's own route, so executing it signs what it proposed
            // rather than what the winner proposed.
            const own = (market.routes ?? []).find((r) => r.id === outcome.proposal.routeId)

            const proposal = measured(
              chainFacts === undefined
                ? settlePlan(outcome.proposal, intent, book)
                : settleChainPlan(outcome.proposal),
              own?.quote as SwapQuote | ChainRouteQuote | undefined,
              market.prices
            )

            attempts.push({
              agent: agent.key,
              model: agent.model,
              ok: true,
              latencyMs: Date.now() - began,
              routeId: proposal.routeId,
              executionMode: proposal.executionMode,
              // Passed for every agent; raceRecordFrom is the one place that
              // keeps it only for the row that actually won.
              reasoning: proposal.reasoning,
            })

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
        await record(null, null, {})
        closed = true
        controller.close()
        return
      }

      // What the user actually asked for, so a follow-on nobody requested
      // can be told apart from one they did. The same parser the sequence
      // flow uses, rather than a second opinion about the same sentence.
      const compound =
        chainFacts === undefined ? parseCompoundIntent(text, market.prices) : undefined
      const followOn = compound?.followOn.kind
      const anchorLimits = (market.offramps ?? []).find((o) => o.asset === 'USDC')

      // A supply or a stake is ranked on the rate each route shows.
      const apyEntries = (market.routes ?? []).flatMap((r) => {
        const q = r.quote as Partial<ChainRouteQuote> | undefined
        return q?.kind === 'chain' && q.apyPercent !== undefined
          ? [[r.id, q.apyPercent] as const]
          : []
      })
      const apyByRoute = apyEntries.length > 0 ? Object.fromEntries(apyEntries) : undefined

      const unmeasuredRoutes = (market.routes ?? [])
        .filter((r) => {
          const q = r.quote as Partial<ChainRouteQuote> | undefined
          return q?.kind === 'chain' && isUnmeasuredSwap(q as ChainRouteQuote)
        })
        .map((r) => r.id)

      const plan: PlanContext = {
        escrowUsd: intent.escrowUsd,
        referencePriceUsd: intent.referencePriceUsd,
        askedToLend: followOn === 'lend',
        askedToOfframp: followOn === 'offramp',
        ...(intent.limitPriceUsd !== undefined
          ? { statedLimitPriceUsd: intent.limitPriceUsd }
          : {}),
        // The live book's two sides are the tightest honest statement of
        // where the market actually is. Absent when it could not be read, and
        // the penalty then falls back to the oracle price.
        ...(book?.bid !== undefined ? { recentLowUsd: book.bid } : {}),
        ...(book?.ask !== undefined ? { recentHighUsd: book.ask } : {}),
        ...(anchorLimits?.maxAmount !== undefined ? { offrampMaxUsd: anchorLimits.maxAmount } : {}),
        ...(anchorLimits?.minAmount !== undefined ? { offrampMinUsd: anchorLimits.minAmount } : {}),
        ...(apyByRoute !== undefined ? { apyByRoute } : {}),
        ...(unmeasuredRoutes.length > 0 ? { unmeasuredRoutes } : {}),
      }

      const scored = scoreProposals(proposals, { competitionId, plan })
      const winner = pickWinner(scored)
      let unanimous: boolean | null = null

      if (winner !== null) {
        const winningProposal = proposals.find((p) => p.agent === winner)
        const chosen = (market.routes ?? []).find((r) => r.id === winningProposal?.routeId)

        // Agreement, named as such. When every agent that could execute chose
        // the same route and the same plan, the "winner" was drawn by hash
        // among equals — and saying "Recommended: Halcyon" over that reads as
        // a judgement nobody made.
        unanimous = unanimousChoice(scored)

        send({
          type: 'competition:winner',
          competitionId,
          winner,
          scores: Object.fromEntries(scored.map((s) => [s.agent, s.score])),
          // Only the agents that actually lost points, so the common case
          // sends nothing extra.
          penalties: Object.fromEntries(
            scored.filter((s) => s.penalties.length > 0).map((s) => [s.agent, s.penalties])
          ),
          unanimous,
          ...(chosen !== undefined ? { route: chosen.quote } : {}),
        })
      }

      await record(
        winner,
        winner !== null ? unanimous : null,
        Object.fromEntries(scored.map((s) => [s.agent, s.score]))
      )
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
