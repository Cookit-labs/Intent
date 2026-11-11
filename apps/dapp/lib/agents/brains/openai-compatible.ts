import { tidyProse } from '../../chat/prose'
import type {
  AgentBrain,
  BrainErrorCode,
  BrainMeta,
  BrainProvider,
  ProposalOutcome,
  ProposalRequest,
  QuotedRoute,
  TalkCall,
  TalkOutcome,
} from '../brain'
import { configuredLendingVenues } from '../../lend/venues'
import { anchorOn, anchorsOn } from '../../offramp/anchors'
import { systemPromptFor } from '../brief'
import { restContextLines } from '../rest-option'
import type { ChainRouteQuote } from '../chain-routes'
import { promptSafe, promptSymbol } from '../prompt-safe'
import { SUBMIT_PROPOSAL_TOOL, validateProposal } from '../tool-schema'
import { enclaveFor, proveReply, type ProofDeps, type ReplyProof } from './nearai-proof'
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
export const MAX_OUTPUT_TOKENS = 16_000

/**
 * One value for every agent. The old per-seat spread (0.2–0.7) was never
 * honoured in thinking mode and is not what makes agents differ; the models
 * are. Mid-range, so a provider that does honour it is neither greedy nor
 * wild.
 */
const TEMPERATURE = 0.4

/** A talk turn's reply is one short tool call, so this holds it with reasoning off. */
const TALK_OUTPUT_TOKENS = 400

export interface BrainOptions {
  /** Which provider's defaults to start from. DeepSeek when unset. */
  provider?: BrainProvider
  apiKey?: string
  model?: string
  baseUrl?: string
  strictTools?: boolean
  fetchImpl?: typeof fetch
  /** How an attested provider's replies are checked. The real services when unset. */
  proofDeps?: ProofDeps
}

interface ChatCompletionReply {
  id?: string
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

export function meta(
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
export function buildMessages(req: ProposalRequest): { role: string; content: string }[] {
  // Every value below that came from outside crosses as one bounded line, and every token symbol
  // as a symbol, because a token's name is chosen by whoever deployed it.
  const venueList = req.market.venues
    .map((v) => `${v.id} (${promptSafe(v.name, 40)}, ${v.category})`)
    .join(', ')
  const priceList = Object.entries(req.market.prices)
    .map(([sym, px]) => `${promptSymbol(sym)}=$${px}`)
    .join(', ')
  const tokenIn = promptSymbol(req.intent.input.tokenIn)
  const tokenOut = promptSymbol(req.intent.input.tokenOut)

  return [
    { role: 'system', content: systemPromptFor(req.chain, req.market.rest !== undefined) },
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
              ...req.market.assets.map(
                (a) =>
                  `  ${promptSymbol(a.code)} — ${promptSafe(a.what)} (${promptSafe(a.trust, 40)})`
              ),
            ]
          : []),
        `Venues available on ${req.chain}: ${venueList}`,
        `Volatility: ${req.market.volatilityHint}. Gas: ${req.market.gasHint}.`,
        ...(req.market.offramps !== undefined && req.market.offramps.length > 0
          ? [
              'Anchors that withdraw to fiat, with live limits:',
              ...req.market.offramps.map(
                (o) =>
                  `  ${promptSafe(o.venue, 40)}: ${promptSymbol(o.asset)}` +
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
        ...(req.market.rest !== undefined ? restContextLines(req.market.rest) : []),
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        // The user's sentence, on one line. A newline in it would read as the
        // next line of the brief rather than more of the intent.
        `Intent: ${promptSafe(req.intent.outcome, 500)}`,
        `Parsed as: ${req.intent.input.type}, ${tokenIn} -> ${tokenOut}`,
        `Size: about $${Math.round(req.intent.escrowUsd)}`,
        // The routes above are live; this table is indicative and can be badly
        // stale. Saying so stops an agent splitting the difference between the
        // two and quoting a price neither source supports.
        ...(req.chain === 'stellar'
          ? [
              `Market reference (context only, NOT the number to quote): $${req.intent.referencePriceUsd} per ${tokenOut}`,
              'Your projectedAvgPriceUsd must come from the route you picked, not from that reference.',
            ]
          : req.intent.referencePriceUsd > 0
            ? [
                `Market reference: $${req.intent.referencePriceUsd} per ${tokenIn}, the token being paid in.`,
              ]
            : []),
        req.intent.targetPriceUsd > 0 ? `Target price: $${req.intent.targetPriceUsd}` : '',
        ...clarifiedLines(req.context),
        '',
        'Submit your proposal.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
  ]
}

const MAX_CONTEXT_LINES = 8
const MAX_CONTEXT_LINE_CHARS = 160

/**
 * The user's own answers to the clarifying questions, one flat line each.
 *
 * Flattened and capped like every other outside string: an answer is text a
 * person typed, and a newline in it would read as the next line of the brief.
 */
function clarifiedLines(context: string[] | undefined): string[] {
  const lines = (context ?? [])
    .slice(0, MAX_CONTEXT_LINES)
    .map((line) => promptSafe(line, MAX_CONTEXT_LINE_CHARS))
    .filter((line) => line !== '')
  if (lines.length === 0) return []
  return ['Confirmed with the user before this race:', ...lines.map((line) => `  ${line}`)]
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
    `Perpetual futures on Noether (${promptSafe(perps.venue, 40)}), read live. The protocol is unaudited and testnet-only; its gateway reports version ${promptSafe(perps.version, 20)}.`,
    ...perps.markets.map(
      (m) =>
        `  ${promptSymbol(m.asset)}: mark $${m.markPriceUsd}` +
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
 * The same routes on a chain other than Stellar.
 *
 * A supply or a stake hands back no amount, so it is shown by its rate and a
 * blank "receive" is never printed. The dollar value a swap delivers is shown
 * beside the amount because tokens of different decimals are only comparable
 * in dollars. Nothing here calls the market synthetic: these are real quotes.
 */
function chainRouteLines(routes: QuotedRoute[]): string[] {
  const line = (r: QuotedRoute): string => {
    const q = r.quote as Partial<ChainRouteQuote> | undefined
    const pay =
      q?.pay !== undefined
        ? `${promptSafe(q.pay.amount, 40)} ${promptSymbol(q.pay.symbol)}`
        : promptSafe(r.sendAmount, 40)
    const gets =
      q?.receive !== undefined
        ? ` -> receive ${promptSafe(q.receive.amount, 40)} ${promptSymbol(q.receive.symbol)}` +
          (q.valueOutUsd !== undefined ? ` (about $${q.valueOutUsd.toFixed(2)})` : '')
        : ''
    const rate = q?.apyPercent !== undefined ? `, ${q.apyPercent}% APY (current rate)` : ''
    return `  ${r.id}: send ${pay}${gets} on ${promptSafe(r.source)}${rate}`
  }
  return [
    '',
    'Routes, already priced by each venue:',
    ...routes.map(line),
    'Choose one by putting its id in routeId. These figures are measured, not estimates,',
    'so do not quote a better number than the route you picked actually offers.',
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
      // A model reasoning briefly left the price at zero here, and a zero price fails the proposal.
      'projectedAvgPriceUsd must still be your estimate, above zero, from the market prices above.',
    ]
  }

  if (req.chain !== 'stellar') return chainRouteLines(routes)

  return [
    '',
    'Executable routes, already priced against live liquidity:',
    ...routes.map(
      (r) =>
        // The path is asset codes anyone can issue; the note echoes a token code
        // the venue's API chose. Both cross as one bounded line.
        `  ${r.id}: send ${promptSafe(r.sendAmount, 40)} -> receive ${promptSafe(r.receiveAmount, 40)} on ${promptSafe(r.source)}, ${r.via !== undefined ? promptSafe(r.via) : `${r.hops} hop(s)`}` +
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
    ? anchorsOn().filter((id) => anchorOn(id)?.requiresClientDomain === false)
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

/**
 * When a 429 says to come back. `Retry-After` is seconds; OpenRouter's
 * `X-RateLimit-Reset` is the epoch millisecond its window reopens.
 */
function retryAfter(headers: Headers): number | undefined {
  const seconds = Number(headers.get('retry-after'))
  if (headers.get('retry-after') !== null && Number.isFinite(seconds)) return seconds * 1000
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset)) return reset - Date.now()
  return undefined
}

/** Every field the proposal tool needs. */
const PROPOSAL_FIELDS: readonly string[] = SUBMIT_PROPOSAL_TOOL.function.parameters.required

/**
 * The model's incomplete call and a line naming what it left out, so the next try fixes that.
 * The reasoning field gets a word on what it is, since that is the one a fast model drops.
 */
export function repairTurn(args: unknown): { role: string; content: string }[] {
  const given = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const missing = PROPOSAL_FIELDS.filter((field) => given[field] === undefined)
  const what =
    missing.length > 0
      ? `That call left out ${missing.join(', ')}.${missing.includes('reasoning') ? ' reasoning is one or two sentences the person reads, saying why you chose this route.' : ''}`
      : 'That call did not pass the checks.'
  return [
    { role: 'assistant', content: `submit_proposal(${JSON.stringify(given)})` },
    {
      role: 'user',
      content: `${what} Call submit_proposal again with every field filled in, using only the routes and figures given above.`,
    },
  ]
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

  /**
   * One chat completion that must come back as a tool call. Everything that can
   * go wrong is returned as a value, so one agent's failure stays its own.
   */
  async function chat(
    body: Record<string, unknown>,
    agent: string,
    signal: AbortSignal | undefined
  ): Promise<TalkOutcome> {
    const startedAt = Date.now()
    const requestBody = JSON.stringify(body)
    // Started before the request, so the enclave evidence predates the reply it vouches for.
    const enclave =
      config.attested === true ? enclaveFor(model, baseUrl, options.proofDeps) : undefined

    let res: Response
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
        ...(signal !== undefined ? { signal } : {}),
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
      // The provider's own words, so a model that left the catalogue or a
      // spent key is told apart from a busy one in the logs. Never the key.
      const reason = await res.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.warn(
        `[agents] ${agent}: HTTP ${res.status} from ${config.id} for ${model}: ${reason.slice(0, 300)}`
      )
      const retryAfterMs = res.status === 429 ? retryAfter(res.headers) : undefined
      return {
        ok: false,
        error: classifyStatus(res.status),
        meta: meta(config, model, Date.now() - startedAt, undefined),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }
    }

    let reply: ChatCompletionResponse & ChatCompletionReply
    // Read as text first: a signature covers the exact bytes, not a re-serialised object.
    let responseBody: string
    try {
      responseBody = await res.text()
      reply = JSON.parse(responseBody) as ChatCompletionResponse & ChatCompletionReply
    } catch {
      return {
        ok: false,
        error: 'invalid_schema',
        meta: meta(config, model, Date.now() - startedAt, undefined),
      }
    }

    const choice = reply.choices?.[0]
    const call = choice?.message?.tool_calls?.[0]?.function
    if (call?.arguments === undefined) {
      // Two very different causes land here, and telling them apart matters:
      // 'length' means the token budget cut the reply off mid-thought, while
      // anything else means the model answered in prose. The first is a
      // configuration problem and the second is a prompting one, so the
      // reason is logged rather than collapsed into a bare schema failure.
      // eslint-disable-next-line no-console
      console.warn(
        `[agents] ${agent}: no tool call (finish_reason=${choice?.finish_reason ?? 'unknown'}, completion_tokens=${reply.usage?.completion_tokens ?? 0})`
      )
      return {
        ok: false,
        error: 'invalid_schema',
        meta: meta(config, model, Date.now() - startedAt, reply.usage),
      }
    }

    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      return {
        ok: false,
        error: 'invalid_schema',
        meta: meta(config, model, Date.now() - startedAt, reply.usage),
      }
    }

    const chatId = reply.id
    let proven: Promise<ReplyProof> | undefined
    const proof =
      enclave !== undefined && typeof chatId === 'string' && apiKey !== undefined
        ? () =>
            (proven ??= proveReply(
              enclave,
              { baseUrl, apiKey, chatId, requestBody, responseBody },
              options.proofDeps
            ))
        : undefined
    return {
      ok: true,
      args,
      meta: meta(config, model, Date.now() - startedAt, reply.usage),
      ...(proof !== undefined ? { proof } : {}),
    }
  }

  return {
    id: config.id,
    displayName: `${config.displayName} (${model})`,
    model,
    isConfigured: () => apiKey !== undefined && apiKey !== '',

    async propose(req: ProposalRequest): Promise<ProposalOutcome> {
      if (apiKey === undefined || apiKey === '') {
        return { ok: false, error: 'no_api_key', meta: meta(config, model, 0, undefined) }
      }

      const tool = strictTools
        ? SUBMIT_PROPOSAL_TOOL
        : {
            ...SUBMIT_PROPOSAL_TOOL,
            function: { ...SUBMIT_PROPOSAL_TOOL.function, strict: false },
          }

      const brief = buildMessages(req)
      const body: Record<string, unknown> = {
        model,
        messages: brief,
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
        ...config.propose?.body,
      }
      const startedAt = Date.now()
      const retry = config.propose?.retryIncomplete
      for (let tries = 1; ; tries++) {
        const out = await chat(body, req.agent, req.signal)
        const outcome = out.ok ? toOutcome(req, out.args, out.meta) : out
        if (outcome.ok) {
          return out.ok && out.proof !== undefined ? { ...outcome, proof: out.proof } : outcome
        }
        // A fast model that left a field out is asked again, while the race still has time for it.
        const again =
          retry !== undefined &&
          outcome.error === 'invalid_schema' &&
          tries < retry.tries &&
          Date.now() - startedAt < retry.withinMs &&
          req.signal?.aborted !== true
        if (!again) return outcome
        // Told what it left out, with its own call beside it: a model fixes a named slip far more
        // reliably than it redoes the whole answer, which repeats the slip.
        if (out.ok) body['messages'] = [...brief, ...repairTurn(out.args)]
      }
    },

    async talk(call: TalkCall): Promise<TalkOutcome> {
      if (apiKey === undefined || apiKey === '') {
        return { ok: false, error: 'no_api_key', meta: meta(config, model, 0, undefined) }
      }
      return chat(
        {
          model,
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.user },
          ],
          tools: [{ type: 'function', function: { ...call.tool, strict: false } }],
          tool_choice: config.toolChoice,
          temperature: TEMPERATURE,
          max_tokens: config.talk?.maxTokens ?? TALK_OUTPUT_TOKENS,
          ...config.talk?.body,
        },
        call.agent,
        call.signal
      )
    },
  }
}

/**
 * A model's tool-call arguments, checked and turned into a proposal.
 *
 * Shared by every brain, whatever its wire format: the arguments are only
 * ever the model's claim, and what makes one a proposal is this validation,
 * not the client that fetched it.
 */
export function toOutcome(req: ProposalRequest, raw: unknown, done: BrainMeta): ProposalOutcome {
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
      meta: done,
    }
  }

  return {
    ok: true,
    proposal: {
      agent: req.agent,
      // Empty means the agent had nothing to choose from; omitted rather
      // than stored as '' so downstream code checks presence, not value.
      ...(validated.value.routeId !== '' ? { routeId: validated.value.routeId } : {}),
      reasoning: tidyProse(validated.value.reasoning),
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
      ...((validated.value.executionMode === 'rest' || validated.value.executionMode === 'split') &&
      validated.value.restPriceUsd > 0
        ? { restPriceUsd: validated.value.restPriceUsd }
        : {}),
      ...(validated.value.executionMode === 'split' ? { splitPct: validated.value.splitPct } : {}),
      // Omitted rather than carried as 'none', so downstream code checks
      // presence like it does for every other optional field here.
      // Validation has already downgraded anything this chain cannot do.
      ...(validated.value.thenAction !== 'none'
        ? { thenAction: validated.value.thenAction, thenVenue: validated.value.thenVenue }
        : {}),
    },
    meta: done,
  }
}
