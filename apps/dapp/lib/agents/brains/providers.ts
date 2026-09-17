import type { BrainProvider } from '../brain'

/**
 * The model providers an agent can run on.
 *
 * Every one of these speaks the OpenAI chat-completions shape, which is the
 * only reason a single client serves all of them: the request body, the
 * `tools` array and the `tool_calls` response are identical across DeepSeek,
 * Groq and Ollama. Verified against each, not assumed — Ollama in particular
 * returns `finish_reason: 'tool_calls'` with `arguments` as a JSON string,
 * exactly as the hosted providers do.
 *
 * Why more than one provider at all: four calls to one model are four samples
 * of one mind. They converge, and a race whose participants agree by
 * construction is not a race. Different models genuinely disagree — about
 * which venue, about whether to wait — and that disagreement is the signal the
 * competition is supposed to produce.
 */

export interface ProviderConfig {
  id: BrainProvider
  displayName: string
  /** Chat-completions base, without the trailing `/chat/completions`. */
  baseUrl: string
  defaultModel: string
  /** Environment variable holding the key. Empty when the provider needs none. */
  apiKeyEnv: string
  /**
   * Whether `strict: true` may be sent on the tool schema.
   *
   * DeepSeek supports it on its beta endpoint. Nothing else here does, and
   * sending it to a provider that rejects unknown fields fails the request
   * outright. Every response is validated application-side regardless, so
   * strict mode is an optimisation rather than a safeguard.
   */
  strictTools: boolean
  /**
   * Whether this provider may be picked without being named.
   *
   * False for anything that needs no key, because "configured" then means
   * nothing: a local daemon that is not running looks identical to one that
   * is, right up until four agents fail at once. Opt in by naming it in
   * `AGENT_BRAINS`, where choosing it is a deliberate act.
   */
  autoSelect: boolean
  /**
   * How the provider chooses whether to call a tool.
   *
   * 'auto' everywhere. DeepSeek's thinking mode rejects a forced choice
   * outright ("Thinking mode does not support this tool_choice"), and Ollama
   * ignores the field. The brief instructs the model to answer by calling the
   * tool, and a prose reply is caught and reported either way.
   */
  toolChoice: 'auto' | 'required'
  /** Per-million-token rates, for reporting spend. Zero for free tiers. */
  pricing: Record<string, { input: number; output: number }>
  /** Fallback rate when the model is not in the table above. */
  defaultPricing: { input: number; output: number }
}

export const PROVIDERS: Record<BrainProvider, ProviderConfig> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/beta',
    defaultModel: 'deepseek-v4-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    strictTools: true,
    autoSelect: true,
    toolChoice: 'auto',
    pricing: {
      'deepseek-v4-flash': { input: 0.22, output: 0.66 },
      'deepseek-v4-pro': { input: 0.66, output: 1.98 },
    },
    defaultPricing: { input: 0.22, output: 0.66 },
  },

  /**
   * Groq's free plan. No payment method, no card on file.
   *
   * **One agent, not four.** The binding limit is tokens per minute rather
   * than requests: the API reports 8,000 TPM against 1,000 requests a day, and
   * one competition prompt costs about 2,300 tokens. Four concurrent agents
   * therefore ask for ~9,200 and exceed it — measured, not predicted: running
   * all four here returned one proposal and three 429s inside 600ms. Two fit;
   * one is comfortable.
   *
   * A 429 is reported as `rate_limited` and not retried, because an agent that
   * answers on a second attempt answers after the race it was in has ended.
   *
   * Fast when it does run: 1.6-1.8s to a validated proposal, against 3.5-4.6s
   * for DeepSeek on the same prompt.
   */
  groq: {
    id: 'groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'qwen/qwen3.8-27b',
    apiKeyEnv: 'GROQ_API_KEY',
    strictTools: false,
    autoSelect: true,
    toolChoice: 'auto',
    pricing: {},
    defaultPricing: { input: 0, output: 0 },
  },

  /**
   * A model running on this machine. Free, unmetered, and unreachable from a
   * deployed build — `localhost:11434` does not exist on Netlify, so an agent
   * configured here in production reports `no_api_key` and shows as an agent
   * that did not answer.
   *
   * Needs no key. `isConfigured` is therefore true whenever the provider is
   * selected, and a dead daemon surfaces as a connection failure on the first
   * request rather than as a configuration problem.
   *
   * Slow enough to shape the whole competition: 45s to a proposal against
   * Groq's 1.7s for a model of the same family, and the agents are awaited
   * together, so one local agent sets the wall clock for all four. Useful
   * when no hosted key is available; not the default when one is.
   */
  ollama: {
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3.5:latest',
    apiKeyEnv: '',
    strictTools: false,
    autoSelect: false,
    toolChoice: 'auto',
    pricing: {},
    defaultPricing: { input: 0, output: 0 },
  },
}

export const ALL_PROVIDERS: readonly BrainProvider[] = Object.keys(PROVIDERS) as BrainProvider[]

export function isBrainProvider(value: string): value is BrainProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value)
}

/**
 * The model this provider will actually use, honouring a per-provider
 * environment override.
 *
 * `GROQ_MODEL`, `OLLAMA_MODEL`, `DEEPSEEK_MODEL` — one per provider, so
 * switching a model does not mean switching provider or editing code.
 */
export function modelFor(provider: BrainProvider, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`${provider.toUpperCase()}_MODEL`]
  return override !== undefined && override !== '' ? override : PROVIDERS[provider].defaultModel
}
