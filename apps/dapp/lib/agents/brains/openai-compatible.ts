import type {
  AgentBrain,
  BrainErrorCode,
  BrainMeta,
  BrainProvider,
  ProposalOutcome,
  ProposalRequest,
} from '../brain'
import { configuredLendingVenues } from '../../lend/venues'
import { ALL_ANCHORS, ANCHORS } from '../../offramp/anchors'
import { SYSTEM_PROMPT } from '../brief'
import { promptSafe } from '../prompt-safe'
import { SUBMIT_PROPOSAL_TOOL, validateProposal } from '../tool-schema'
import type { ProviderConfig } from './providers'
import { PROVIDERS, modelFor } from './providers'

/**
 * One agent, on any provider that speaks OpenAI chat-completions.
 *
 * DeepSeek, Groq and a local Ollama daemon all serve the identical request and
 * response shape, so what separates them is configuration rather than code:
 * endpoint, model, key, and whether strict tool schemas are accepted. That
 * table lives in `providers.ts`; everything below is the same for all of them.
 *
 * `fetch` directly rather than an SDK: one POST does not justify the dependency
 * surface, and an injectable `fetch` makes every failure path testable without
 * a network. Injectable configuration is also what lets four agents run on
 * three different models in one competition.
 *
 * Every model here is chosen on cost — free, or roughly an order of magnitude
 * cheaper per token than a frontier model at this workload's size. All are
 * weaker at factual recall than they are at judgement, which is why each call
 * is short, bounded, and handed every price it needs rather than asked to
 * remember one.
 */

/**
 * Covers the tool call plus the thinking tokens the model spends before it.
 *
 * These models reason before answering, and that reasoning is billed and
 * counted here. Measured: a single strategy uses 400-900 completion tokens on a
 * one-venue prompt, and at a 400 ceiling the reply is cut off mid-thought —
 * `finish_reason: length`, no tool call at all. That surfaces as a schema
 * failure, which reads like the model misbehaving when the real cause is the
 * budget.
 *
 * Raised again once agents were given two venues to compare: weighing routes
 * that deliver different assets is a genuinely harder question, and agents were
 * observed spending the full 4,000 on it and still being truncated. The
 * headroom is deliberate; unused tokens are not billed.
 */
// Raised again after an agent was observed spending the full 8,000 on a
// four-asset prompt and still being cut off mid-thought — `finish_reason:
// length`, no tool call, which surfaces as a schema failure and gets replaced
// by a canned proposal. Unused tokens are not billed, so the headroom costs
// nothing and the failure it prevents is the one that makes the whole
// competition look fabricated.
const MAX_OUTPUT_TOKENS = 16_000

/**
 * One value for every agent. The old per-seat spread (0.2–0.7) was never
 * honoured in thinking mode and is not what makes agents differ; the models
 * are. Mid-range, so a provider that does honour it is neither greedy nor
 * wild.
 */
const TEMPERATURE = 0.4

export interface BrainOptions {
  /** Which provider's defaults to start from. DeepSeek when unset. */
  provider?: BrainProvider
  apiKey?: string
  model?: string
  baseUrl?: string
  strictTools?: boolean
  fetchImpl?: typeof fetch
}

interface ChatCompletionResponse {
  choices?: {
    /** 'length' means the reply was cut off before the tool call was finished. */
    finish_reason?: string
    message?: {
      content?: string
      tool_calls?: { function?: { name?: string; arguments?: string } }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
  }
}

function estimateCost(
  config: ProviderConfig,
  model: string,
  inTokens: number,
  outTokens: number
): number {
  const rate = config.pricing[model] ?? config.defaultPricing
  return (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output
}

function meta(
  config: ProviderConfig,
  model: string,
  latencyMs: number,
  usage: ChatCompletionResponse['usage']
): BrainMeta {
  const promptTokens = usage?.prompt_tokens ?? 0
  const completionTokens = usage?.completion_tokens ?? 0
  return {
    provider: config.id,
    model,
    latencyMs,
    promptTokens,
    completionTokens,
    // DeepSeek reports cache hits; the others do not, and an absent field is
    // zero rather than a guess.
    cachedTokens: usage?.prompt_cache_hit_tokens ?? 0,
    costUsd: estimateCost(config, model, promptTokens, completionTokens),
  }
}

/**
 * Message order is a cost decision, not a style one.
 *
 * Caching matches on a prefix, and a cache hit is roughly fifty times cheaper
 * than a miss. So the parts that never change go first (shared rules, then the
 * strategy prompt), the slowly-changing market context next, and the user's
 * intent — the only genuinely unique part — last. Reversing this still works
 * and still returns the right answer; it just quietly costs ~50x more.
 */
function buildMessages(req: ProposalRequest): { role: string; content: string }[] {
  const venueList = req.market.venues.map((v) => `${v.id} (${v.name}, ${v.category})`).join(', ')
  const priceList = Object.entries(req.market.prices)
    .map(([sym, px]) => `${sym}=$${px}`)
    .join(', ')

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: [
        `Market context (as of ${req.market.asOf}):`,
        `Prices: ${priceList}`,
        // Named explicitly, with what each one is. A model that has only ever
        // seen currencies in this prompt has no reason to consider tokenized
        // sovereign debt, and would never propose it however well it suited
        // the intent.
        ...(req.market.assets !== undefined && req.market.assets.length > 0
          ? [
              'Assets you may trade:',
              ...req.market.assets.map((a) => `  ${a.code} — ${a.what} (${a.trust})`),
            ]
          : []),
        `Venues available on ${req.chain}: ${venueList}`,
        `Volatility: ${req.market.volatilityHint}. Gas: ${req.market.gasHint}.`,
        ...(req.market.offramps !== undefined && req.market.offramps.length > 0
          ? [
              'Anchors that withdraw to fiat, with live limits:',
              ...req.market.offramps.map(
                (o) =>
                  `  ${o.venue}: ${o.asset}` +
                  (o.minAmount !== undefined ? `, min ${o.minAmount}` : '') +
                  (o.maxAmount !== undefined ? `, max ${o.maxAmount}` : '') +
                  (o.feeEnabled ? ', charges a fee' : ', no fee')
              ),
            ]
          : []),
        // One line per venue, with the figure's provenance, because the two
        // venues' numbers are not the same kind of number: Blend's is the
        // pool's instantaneous supply rate derived from its curve; DeFindex's
        // is a trailing 7-day yield its API reports net of fees. Both are
        // testnet figures — synthetic liquidity, synthetic borrowing demand —
        // which is said outright so an agent does not present a three-digit
        // APY to the user as a forecast. Venue and asset names cross the
        // prompt boundary bounded, like every other outside string.
        ...(req.market.lending !== undefined && req.market.lending.length > 0
          ? [
              'Lending venues, with live supply rates (testnet figures, not a forecast):',
              ...req.market.lending.map(
                (l) =>
                  `  ${promptSafe(l.venue, 40)}: ${promptSafe(l.asset, 16)} at ${l.supplyApy}% APY` +
                  (l.utilisation !== undefined ? `, ${l.utilisation}% utilised` : '') +
                  (l.basis !== undefined ? ` (${promptSafe(l.basis, 60)})` : '')
              ),
            ]
          : []),
        ...perpLines(req),
        ...routeLines(req),
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        // The user's sentence, on one line. A newline in it would read as the
        // next line of the brief rather than more of the intent.
        `Intent: ${promptSafe(req.intent.outcome, 500)}`,
        `Parsed as: ${req.intent.input.type}, ${req.intent.input.tokenIn} -> ${req.intent.input.tokenOut}`,
        `Size: about $${Math.round(req.intent.escrowUsd)}`,
        // The routes above are live; this table is indicative and can be badly
        // stale. Saying so stops an agent splitting the difference between the
        // two and quoting a price neither source supports.
        `Market reference (context only, NOT the number to quote): $${req.intent.referencePriceUsd} per ${req.intent.input.tokenOut}`,
        'Your projectedAvgPriceUsd must come from the route you picked, not from that reference.',
        req.intent.targetPriceUsd > 0 ? `Target price: $${req.intent.targetPriceUsd}` : '',
        '',
        'Submit your proposal.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
  ]
}

/**
 * Live perp figures, stated as facts and fenced off from the proposal.
 *
 * The schema has no way to express a leveraged position, so an agent that
 * read "XLM open interest is short-heavy" and proposed a long would produce a
 * proposal the validator refuses. The fence is said in the same breath as
 * the figures, where a model is most likely to read it.
 */
function perpLines(req: ProposalRequest): string[] {
  const perps = req.market.perps
  if (perps === undefined || perps.markets.length === 0) return []
  const usd = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return [
    `Perpetual futures on Noether (${perps.venue}), read live. The protocol is unaudited and testnet-only; its gateway reports version ${perps.version}.`,
    ...perps.markets.map(
      (m) =>
        `  ${m.asset}: mark $${m.markPriceUsd}` +
        (m.openInterestLongUsd !== undefined && m.openInterestShortUsd !== undefined
          ? `, open interest long $${usd(m.openInterestLongUsd)} / short $${usd(m.openInterestShortUsd)}`
          : '') +
        (m.openPositions !== undefined ? `, ${m.openPositions} open positions` : '')
    ),
    ...(perps.vaultApyPct !== undefined ? [`  vault APY ${perps.vaultApyPct}%`] : []),
    'The gateway reports no funding rate. A perp cannot be proposed as a plan step yet; use these figures as context for the spot trade only.',
  ]
}

/**
 * Presents the priced routes the agent must choose between.
 *
 * These are real quotes against real liquidity, so the instruction is explicit
 * that they are not to be improved upon: the failure mode worth designing
 * against is a model quoting a better number than the market offered.
 */
function routeLines(req: ProposalRequest): string[] {
  // Each agent sees the same routes in a different order. Four agents given
  // the same list in the same order tend to anchor on whichever comes first,
  // which is not four opinions. A rotation by the agent's position is
  // deterministic — the same agent always sees the same order — and changes
  // nothing about the facts, only which one is read first.
  const offered = req.market.routes ?? []
  const shift = req.seat % Math.max(1, offered.length)
  const routes = [...offered.slice(shift), ...offered.slice(0, shift)]
  if (routes.length === 0) {
    return [
      '',
      'No executable routes were found for this pair. Reason about the intent, and return an empty routeId.',
    ]
  }

  return [
    '',
    'Executable routes, already priced against live liquidity:',
    ...routes.map(
      (r) =>
        // The path is asset codes anyone can issue; the note echoes a token code
        // the venue's API chose. Both cross as one bounded line.
        `  ${r.id}: send ${r.sendAmount} -> receive ${r.receiveAmount} on ${r.source}, ${r.via !== undefined ? promptSafe(r.via) : `${r.hops} hop(s)`}` +
        (r.executable ? '' : ' [COMPARISON ONLY, cannot be executed]') +
        (r.note !== undefined ? ` [${promptSafe(r.note, 160)}]` : '')
    ),
    'Choose one by putting its id in routeId. These prices are measured, not estimates —',
    'do not quote a better number than the route you picked actually offers.',
    // Comparing two venues on output alone is wrong when they deliver different
    // assets, and picking an unexecutable one would promise a fill that cannot
    // be signed.
    'Routes marked COMPARISON ONLY deliver a different asset and must not be put',
    'in routeId. Use them to judge whether the executable price is competitive.',
    '',
    // Said outright because the two numbers genuinely disagree. Without this an
    // agent notices the contradiction and splits the difference, quoting a
    // price neither the market nor the route supports.
    'Note: this is a testnet. Its liquidity is synthetic, so the rate a route',
    'offers can differ sharply from the real market prices listed above. Quote',
    'the rate of the route you picked. Use the market prices to judge whether',
    'the trade makes sense, not to second-guess the route.',
  ]
}

/**
 * The USD rate the best offered route actually implies, per unit sold.
 *
 * Derived from the quote rather than the price table because the table is a
 * rough scale for reasoning, while the route is what the market will pay right
 * now. Undefined when nothing was quoted, in which case the table is all there
 * is.
 */
/**
 * The rate each offered route implies, as an exchange rate.
 *
 * Every route, not just the first. That distinction is the whole point: the
 * agents are shown two venues whose prices genuinely differ — Horizon quoting
 * 503 XLM for 500 USDC against Soroswap's 4,732 for the same input — and an
 * agent choosing the better one was being judged against the worse one's rate.
 *
 * The result was that all four agents quoted 0.1056, the honest Soroswap rate,
 * and all four were rejected as implausible. The server then substituted
 * canned mock proposals, so the app displayed strategies citing Curve and
 * Uniswap on a Stellar intent. It looked hardcoded because it was — the real
 * agents had been reasoning correctly and getting thrown away.
 *
 * No market price is applied. These are exchange rates; multiplying by a
 * destination price produces a USD value ratio, which is a different quantity
 * and does not belong in the same comparison.
 */
/**
 * Lending venues the intent's chain can actually execute against.
 *
 * Empty on any chain without a lending integration, which is every chain but
 * Stellar today. An agent that proposes lending on Arc is not punished for it:
 * the follow-on is downgraded and the trade stands.
 *
 * On Stellar, the venues this deployment is configured for — read at call
 * time, so DeFindex joins the moment its key is set and leaves the moment it
 * is not, without a restart of anything that holds a brain.
 */
function lendingVenuesFor(req: ProposalRequest): string[] {
  return req.chain === 'stellar' ? configuredLendingVenues() : []
}

/**
 * Anchors this deployment can actually complete a withdrawal through.
 *
 * An anchor whose SEP-10 challenge requires a `client_domain` (MoneyGram
 * today) is excluded here, not just refused later: this deployment has no
 * such domain, so offering it would let an agent propose a step that can
 * never be completed rather than one this chain merely lacks.
 */
function offrampVenuesFor(req: ProposalRequest): string[] {
  return req.chain === 'stellar'
    ? ALL_ANCHORS.filter((id) => !ANCHORS[id].requiresClientDomain)
    : []
}

function impliedRates(req: ProposalRequest): number[] {
  const rates: number[] = []

  for (const route of req.market.routes ?? []) {
    const sent = Number.parseFloat(route.sendAmount)
    const received = Number.parseFloat(route.receiveAmount)
    if (!Number.isFinite(sent) || !Number.isFinite(received)) continue
    if (sent <= 0 || received <= 0) continue
    rates.push(received / sent)
  }

  return rates
}

function classifyStatus(status: number): BrainErrorCode {
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'invalid_schema'
  return 'upstream_error'
}

export function createBrain(options: BrainOptions = {}): AgentBrain {
  const config = PROVIDERS[options.provider ?? 'deepseek']

  // A provider that needs no key — a local daemon — is configured by being
  // selected. Reachability is a request-time failure, not a setup one.
  const apiKey =
    options.apiKey ?? (config.apiKeyEnv === '' ? 'local' : process.env[config.apiKeyEnv])
  const model = options.model ?? modelFor(config.id)
  const strictTools =
    options.strictTools ??
    (config.strictTools && process.env[`${config.id.toUpperCase()}_STRICT_TOOLS`] !== 'false')
  // DeepSeek serves strict tool schemas from its beta endpoint and the standard
  // shape from its main one; every other provider has a single base.
  const baseUrl =
    options.baseUrl ??
    process.env[`${config.id.toUpperCase()}_BASE_URL`] ??
    (config.id === 'deepseek' && !strictTools ? 'https://api.deepseek.com' : config.baseUrl)
  const doFetch = options.fetchImpl ?? fetch

  return {
    id: config.id,
    displayName: `${config.displayName} (${model})`,
    model,
    isConfigured: () => apiKey !== undefined && apiKey !== '',

    async propose(req: ProposalRequest): Promise<ProposalOutcome> {
      const startedAt = Date.now()

      if (apiKey === undefined || apiKey === '') {
        return { ok: false, error: 'no_api_key', meta: meta(config, model, 0, undefined) }
      }

      const tool = strictTools
        ? SUBMIT_PROPOSAL_TOOL
        : {
            ...SUBMIT_PROPOSAL_TOOL,
            function: { ...SUBMIT_PROPOSAL_TOOL.function, strict: false },
          }

      let res: Response
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: buildMessages(req),
            tools: [tool],
            // 'auto' for every provider today. DeepSeek's models reason in
            // thinking mode, which rejects a forced tool_choice outright:
            // "Thinking mode does not support this tool_choice"; Ollama ignores
            // the field entirely. The brief already instructs the
            // model to answer by calling the tool, and a reply that arrives as
            // prose anyway is caught below — so forcing buys nothing.
            tool_choice: config.toolChoice,
            temperature: TEMPERATURE,
            max_tokens: MAX_OUTPUT_TOKENS,
          }),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        })
      } catch (e) {
        // An aborted request is the timeout the caller asked for, not a fault.
        const aborted = e instanceof Error && e.name === 'AbortError'
        return {
          ok: false,
          error: aborted ? 'timeout' : 'upstream_error',
          meta: meta(config, model, Date.now() - startedAt, undefined),
        }
      }

      if (!res.ok) {
        return {
          ok: false,
          error: classifyStatus(res.status),
          meta: meta(config, model, Date.now() - startedAt, undefined),
        }
      }

      let body: ChatCompletionResponse
      try {
        body = (await res.json()) as ChatCompletionResponse
      } catch {
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(config, model, Date.now() - startedAt, undefined),
        }
      }

      const choice = body.choices?.[0]
      const call = choice?.message?.tool_calls?.[0]?.function
      if (call?.arguments === undefined) {
        // Two very different causes land here, and telling them apart matters:
        // 'length' means the token budget cut the reply off mid-thought, while
        // anything else means the model answered in prose. The first is a
        // configuration problem and the second is a prompting one, so the
        // reason is logged rather than collapsed into a bare schema failure.
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] ${req.agent}: no tool call (finish_reason=${choice?.finish_reason ?? 'unknown'}, completion_tokens=${body.usage?.completion_tokens ?? 0})`
        )
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(config, model, Date.now() - startedAt, body.usage),
        }
      }

      let raw: unknown
      try {
        raw = JSON.parse(call.arguments)
      } catch {
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(config, model, Date.now() - startedAt, body.usage),
        }
      }

      const validated = validateProposal(raw, {
        // When a route was quoted, its implied rate is the reference: it came
        // from live liquidity, while the price table is indicative and can be
        // stale by a wide margin. Rejecting an agent for agreeing with the
        // market would be exactly backwards.
        // Both bases are offered because both are shown to the agent: the
        // route rate it is told to quote, and the market price it is told to
        // sanity-check against.
        referencePriceUsd: req.intent.referencePriceUsd,
        // Every route's rate is a legitimate answer, because an agent may
        // pick any of them. Passing only one made choosing the better venue
        // look like a fabrication.
        routeRates: impliedRates(req),
        // Venues on this chain, plus the venue of every route the agent was
        // shown and the route ids themselves. A route's source is on this
        // chain by construction, but "horizon" is not in the venue list — so
        // an agent picking the classic route had no correct venue to name —
        // and agents also put a route id in this field, which is a slip in a
        // label, not reasoning about the wrong chain. Uniswap on Stellar
        // still fails; horizon-1 on Stellar does not.
        allowedVenueIds: [
          ...req.market.venues.map((v) => v.id),
          ...(req.market.routes ?? []).flatMap((r) => [r.source, r.id]),
        ],
        ...(req.market.routes !== undefined
          ? {
              // Only executable routes are selectable. The prompt says so too,
              // but a model that ignores it must still be refused here: an
              // unexecutable winner is a fill the user cannot sign.
              allowedRouteIds: req.market.routes.filter((r) => r.executable).map((r) => r.id),
            }
          : {}),
        // Which lending venues this chain can actually reach. An agent naming
        // one that is absent has its follow-on downgraded rather than its
        // whole proposal rejected: the trade is still sound, and the second
        // step was optional.
        lendingVenueIds: lendingVenuesFor(req),
        // Which anchors this deployment can actually complete a withdrawal
        // through. Same downgrade discipline as lending: naming one absent
        // here loses only the follow-on, not the trade.
        offrampVenueIds: offrampVenuesFor(req),
      })

      if (!validated.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[agents] ${req.agent}: rejected — ${validated.reason}`)
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(config, model, Date.now() - startedAt, body.usage),
        }
      }

      return {
        ok: true,
        proposal: {
          agent: req.agent,
          // Empty means the agent had nothing to choose from; omitted rather
          // than stored as '' so downstream code checks presence, not value.
          ...(validated.value.routeId !== '' ? { routeId: validated.value.routeId } : {}),
          reasoning: validated.value.reasoning,
          projectedAvgPriceUsd: validated.value.projectedAvgPriceUsd,
          projectedSlippagePct: validated.value.projectedSlippagePct,
          venues: validated.value.venues,
          sliceCount: validated.value.sliceCount,
          confidence: validated.value.confidence,
          horizonMinutes: validated.value.horizonMinutes,
          executionMode: validated.value.executionMode,
          // Zero is how a filling proposal expresses "no resting price", since
          // strict mode has no optional properties. Carrying it through as a
          // real zero would read as a price of nothing.
          ...((validated.value.executionMode === 'rest' ||
            validated.value.executionMode === 'split') &&
          validated.value.restPriceUsd > 0
            ? { restPriceUsd: validated.value.restPriceUsd }
            : {}),
          ...(validated.value.executionMode === 'split'
            ? { splitPct: validated.value.splitPct }
            : {}),
          // Omitted rather than carried as 'none', so downstream code checks
          // presence like it does for every other optional field here.
          // Validation has already downgraded anything this chain cannot do.
          ...(validated.value.thenAction !== 'none'
            ? { thenAction: validated.value.thenAction, thenVenue: validated.value.thenVenue }
            : {}),
        },
        meta: meta(config, model, Date.now() - startedAt, body.usage),
      }
    },
  }
}

/**
 * One brain per provider, built once.
 *
 * Built eagerly because construction is a few reads of `process.env` and
 * nothing more — no client, no connection. Whether a provider is usable is
 * `isConfigured()`, which the registry checks; an unconfigured brain existing
 * costs nothing and is never handed to an agent.
 */
export const BRAINS: Record<BrainProvider, AgentBrain> = {
  deepseek: createBrain({ provider: 'deepseek' }),
  groq: createBrain({ provider: 'groq' }),
  ollama: createBrain({ provider: 'ollama' }),
  openrouter: createBrain({ provider: 'openrouter' }),
}
