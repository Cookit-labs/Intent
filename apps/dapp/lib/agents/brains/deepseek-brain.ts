import type {
  AgentBrain,
  BrainErrorCode,
  BrainMeta,
  ProposalOutcome,
  ProposalRequest,
} from '../brain'
import { STRATEGIES } from '../strategies'
import { SUBMIT_PROPOSAL_TOOL, validateProposal } from '../tool-schema'

/**
 * DeepSeek-backed agent.
 *
 * Chosen on cost — roughly an order of magnitude cheaper per token than
 * frontier models at this workload's size. It is weaker at factual recall and
 * at long agentic loops, which is why each call is short, bounded, and handed
 * every price it needs rather than being asked to remember any.
 *
 * The provider is reached through its OpenAI-compatible endpoint, so `fetch` is
 * used directly rather than the SDK: one chat-completions POST does not justify
 * the dependency surface, and an injectable `fetch` makes every failure path
 * testable without a network.
 */

/** Rough per-token rates, used only for reporting spend back to the caller. */
const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.22, output: 0.66 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98 },
}

/**
 * Covers the tool call plus the thinking tokens the model spends before it.
 *
 * These models reason before answering, and that reasoning is billed and
 * counted here. Measured: a single strategy uses 400-900 completion tokens, and
 * at a 400 ceiling the reply is cut off mid-thought — `finish_reason: length`,
 * no tool call at all. That surfaces as a schema failure, which reads like the
 * model misbehaving when the real cause is the budget. The headroom is
 * deliberate; unused tokens are not billed.
 */
const MAX_OUTPUT_TOKENS = 4_000

export interface DeepSeekBrainOptions {
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

function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const rate = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK['deepseek-v4-flash']
  if (rate === undefined) return 0
  return (inTokens / 1_000_000) * rate.input + (outTokens / 1_000_000) * rate.output
}

function meta(
  model: string,
  latencyMs: number,
  usage: ChatCompletionResponse['usage'],
  degraded: boolean
): BrainMeta {
  const promptTokens = usage?.prompt_tokens ?? 0
  const completionTokens = usage?.completion_tokens ?? 0
  return {
    provider: 'deepseek',
    model,
    latencyMs,
    promptTokens,
    completionTokens,
    cachedTokens: usage?.prompt_cache_hit_tokens ?? 0,
    costUsd: estimateCost(model, promptTokens, completionTokens),
    degraded,
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
  const strategy = STRATEGIES[req.strategy]
  const venueList = req.market.venues.map((v) => `${v.id} (${v.name}, ${v.category})`).join(', ')
  const priceList = Object.entries(req.market.prices)
    .map(([sym, px]) => `${sym}=$${px}`)
    .join(', ')

  return [
    { role: 'system', content: strategy.systemPrompt },
    {
      role: 'system',
      content: [
        `Market context (as of ${req.market.asOf}):`,
        `Prices: ${priceList}`,
        `Venues available on ${req.chain}: ${venueList}`,
        `Volatility: ${req.market.volatilityHint}. Gas: ${req.market.gasHint}.`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Intent: ${req.intent.outcome}`,
        `Parsed as: ${req.intent.input.type}, ${req.intent.input.tokenIn} -> ${req.intent.input.tokenOut}`,
        `Size: about $${Math.round(req.intent.escrowUsd)}`,
        `Reference price: $${req.intent.referencePriceUsd}`,
        req.intent.targetPriceUsd > 0 ? `Target price: $${req.intent.targetPriceUsd}` : '',
        '',
        'Submit your proposal.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
  ]
}

function classifyStatus(status: number): BrainErrorCode {
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'invalid_schema'
  return 'upstream_error'
}

export function createDeepSeekBrain(options: DeepSeekBrainOptions = {}): AgentBrain {
  const apiKey = options.apiKey ?? process.env['DEEPSEEK_API_KEY']
  const model = options.model ?? process.env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash'
  const strictTools =
    options.strictTools ?? process.env['DEEPSEEK_STRICT_TOOLS'] !== 'false'
  // Strict tool schemas live on the beta endpoint; without them the standard
  // one is fine, since every response is validated application-side anyway.
  const baseUrl =
    options.baseUrl ??
    process.env['DEEPSEEK_BASE_URL'] ??
    (strictTools ? 'https://api.deepseek.com/beta' : 'https://api.deepseek.com')
  const doFetch = options.fetchImpl ?? fetch

  return {
    id: 'deepseek',
    displayName: 'DeepSeek agents',
    isConfigured: () => apiKey !== undefined && apiKey !== '',

    async propose(req: ProposalRequest): Promise<ProposalOutcome> {
      const startedAt = Date.now()

      if (apiKey === undefined || apiKey === '') {
        return { ok: false, error: 'no_api_key', meta: meta(model, 0, undefined, true) }
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
            // 'auto', not a forced function. DeepSeek's models reason in
            // thinking mode, which rejects a forced tool_choice outright:
            // "Thinking mode does not support this tool_choice". The strategy
            // prompts already instruct the model to answer by calling the tool,
            // and a reply that arrives as prose anyway is caught below and
            // falls back — so forcing buys nothing and costs every request.
            tool_choice: 'auto',
            temperature: STRATEGIES[req.strategy].temperature,
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
          meta: meta(model, Date.now() - startedAt, undefined, true),
        }
      }

      if (!res.ok) {
        return {
          ok: false,
          error: classifyStatus(res.status),
          meta: meta(model, Date.now() - startedAt, undefined, true),
        }
      }

      let body: ChatCompletionResponse
      try {
        body = (await res.json()) as ChatCompletionResponse
      } catch {
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(model, Date.now() - startedAt, undefined, true),
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
          `[agents] ${req.strategy}: no tool call (finish_reason=${choice?.finish_reason ?? 'unknown'}, completion_tokens=${body.usage?.completion_tokens ?? 0})`
        )
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(model, Date.now() - startedAt, body.usage, true),
        }
      }

      let raw: unknown
      try {
        raw = JSON.parse(call.arguments)
      } catch {
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(model, Date.now() - startedAt, body.usage, true),
        }
      }

      const validated = validateProposal(raw, {
        referencePriceUsd: req.intent.referencePriceUsd,
        allowedVenueIds: req.market.venues.map((v) => v.id),
      })

      if (!validated.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[agents] ${req.strategy}: rejected — ${validated.reason}`)
        return {
          ok: false,
          error: 'invalid_schema',
          meta: meta(model, Date.now() - startedAt, body.usage, true),
        }
      }

      return {
        ok: true,
        proposal: {
          strategy: req.strategy,
          reasoning: validated.value.reasoning,
          projectedAvgPriceUsd: validated.value.projectedAvgPriceUsd,
          projectedSlippagePct: validated.value.projectedSlippagePct,
          venues: validated.value.venues,
          sliceCount: validated.value.sliceCount,
          confidence: validated.value.confidence,
          horizonMinutes: validated.value.horizonMinutes,
        },
        meta: meta(model, Date.now() - startedAt, body.usage, false),
      }
    },
  }
}

export const deepseekBrain: AgentBrain = createDeepSeekBrain()
