import Anthropic from '@anthropic-ai/sdk'

import type { AgentBrain, ProposalOutcome, ProposalRequest } from '../brain'
import { SUBMIT_PROPOSAL_TOOL } from '../tool-schema'
import { MAX_OUTPUT_TOKENS, buildMessages, meta, toOutcome } from './openai-compatible'
import { PROVIDERS, modelFor } from './providers'

/**
 * One agent on Claude, through Anthropic's own SDK.
 *
 * Not one of the chat-completions providers: the Messages API takes the
 * system prompt as its own field, tools as `input_schema`, and returns the
 * call as a `tool_use` block with its input already parsed. What the agent is
 * told and how its answer is judged are shared with the others —
 * `buildMessages` and `toOutcome` — so Claude competes on the same brief and
 * the same rules.
 *
 * Thinking is always on for this model and cannot be turned off; effort is
 * the only control, set explicitly because the model's default (medium)
 * differs from its predecessor's. Forced tool use is rejected, so the tool is
 * offered with `auto` and `strict` keeps its arguments to the schema.
 *
 * Server-side refusal fallbacks are on: a request the model's safety
 * classifiers decline is re-run on a fallback model chosen by refusal
 * category, inside the same call, rather than ending the agent's turn.
 */

const config = PROVIDERS.anthropic

/**
 * Claude's strict tool mode rejects `minimum`/`maximum` on a number property
 * ("properties maximum, minimum are not supported") — OpenAI's accepts them.
 * The bound is still stated in that property's description and still
 * enforced at runtime by `validateProposal`, so dropping it here only
 * changes what the model is shown up front, not what is allowed through.
 */
function stripNumericBounds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripNumericBounds)
  if (schema === null || typeof schema !== 'object') return schema
  const { minimum: _min, maximum: _max, ...rest } = schema as Record<string, unknown>
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, stripNumericBounds(v)]))
}

const TOOL = {
  name: SUBMIT_PROPOSAL_TOOL.function.name,
  description: SUBMIT_PROPOSAL_TOOL.function.description,
  input_schema: stripNumericBounds(
    SUBMIT_PROPOSAL_TOOL.function.parameters
  ) as Anthropic.Beta.BetaTool['input_schema'],
  strict: true,
}

export interface ClaudeBrainOptions {
  apiKey?: string
  model?: string
  /** For tests: a client whose transport is faked. */
  client?: Anthropic
}

export function createClaudeBrain(options: ClaudeBrainOptions = {}): AgentBrain {
  const apiKey = options.apiKey ?? process.env[config.apiKeyEnv]
  const model = options.model ?? modelFor(config.id)
  let client = options.client

  return {
    id: config.id,
    displayName: `${config.displayName} (${model})`,
    model,
    isConfigured: () => options.client !== undefined || (apiKey !== undefined && apiKey !== ''),

    async propose(req: ProposalRequest): Promise<ProposalOutcome> {
      const startedAt = Date.now()
      const elapsed = (): number => Date.now() - startedAt

      if (client === undefined) {
        if (apiKey === undefined || apiKey === '') {
          return { ok: false, error: 'no_api_key', meta: meta(config, model, 0, undefined) }
        }
        // No retries: an answer on a second attempt arrives after the race
        // it was meant for has ended.
        client = new Anthropic({ apiKey, maxRetries: 0 })
      }

      const messages = buildMessages(req)
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content)

      let response: Anthropic.Beta.BetaMessage
      try {
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'medium' },
            // The brief is identical for every race, so it is cached; the
            // market and the intent after it are not.
            system: system.map((text, i) => ({
              type: 'text' as const,
              text,
              ...(i === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}),
            })),
            messages: messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: 'user' as const, content: m.content })),
            tools: [TOOL],
            tool_choice: { type: 'auto' },
          },
          req.signal !== undefined ? { signal: req.signal } : undefined
        )
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError) {
          return { ok: false, error: 'timeout', meta: meta(config, model, elapsed(), undefined) }
        }
        if (e instanceof Anthropic.APIError) {
          // eslint-disable-next-line no-console
          console.warn(
            `[agents] ${req.agent}: HTTP ${e.status ?? '-'} from anthropic for ${model}: ${e.message.slice(0, 300)}`
          )
        }
        if (e instanceof Anthropic.RateLimitError) {
          const seconds = Number(e.headers.get('retry-after'))
          return {
            ok: false,
            error: 'rate_limited',
            meta: meta(config, model, elapsed(), undefined),
            ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}),
          }
        }
        if (e instanceof Anthropic.BadRequestError) {
          return {
            ok: false,
            error: 'invalid_schema',
            meta: meta(config, model, elapsed(), undefined),
          }
        }
        return {
          ok: false,
          error: 'upstream_error',
          meta: meta(config, model, elapsed(), undefined),
        }
      }

      const usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        prompt_cache_hit_tokens: response.usage.cache_read_input_tokens ?? 0,
      }

      if (response.stop_reason === 'refusal') {
        return { ok: false, error: 'refused', meta: meta(config, model, elapsed(), usage) }
      }

      const call = response.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name
      )
      if (call === undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agents] ${req.agent}: no tool call (stop_reason=${response.stop_reason ?? 'unknown'}, output_tokens=${response.usage.output_tokens})`
        )
        return { ok: false, error: 'invalid_schema', meta: meta(config, model, elapsed(), usage) }
      }

      return toOutcome(req, call.input, meta(config, model, elapsed(), usage))
    },
  }
}
