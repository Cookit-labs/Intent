import type { AgentKey, BrainProvider } from './brain'
import { PROVIDERS } from './brains/providers'
import { keyHash } from './persona'

/**
 * An agent is a model. Everything that identifies one on a card, in history
 * and on the leaderboard derives from provider + model here, so the same
 * model is the same agent in every race and every deploy, and nothing is
 * assigned by hand.
 */

/** `provider:model`. The model part is the resolved id, so an alias and its id are one agent. */
export function agentKey(provider: BrainProvider, model: string): AgentKey {
  return `${provider}:${model}`
}

/**
 * A readable name from a model id.
 *
 * Ids come in three shapes — `qwen/qwen3.8-27b`, `qwen3.5:latest`,
 * `deepseek-v4-flash` — and only the middle part names the model. Version
 * and size tokens are upper-cased; everything else is capitalised.
 */
export function prettyModel(model: string): string {
  const withoutVendor = model.includes('/') ? (model.split('/').pop() ?? model) : model
  const withoutTag = withoutVendor.split(':')[0] ?? withoutVendor
  return withoutTag
    .split('-')
    .filter((t) => t !== '')
    .map((t) => (/^(v\d|\d+(\.\d+)?b$|a\d+b$)/i.test(t) ? t.toUpperCase() : capitalise(t)))
    .join(' ')
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The codename each racing model goes by, keyed by model id so it is the same on every chain and
 * in every race. The real model stays beside it in small text. Chosen by the user, 11 November 2026.
 */
export const CODENAMES: Readonly<Record<string, string>> = {
  'claude-sonnet-5-5': 'Vega',
  'deepseek-v4-flash': 'Orion',
  'qwen/qwen3.8-27b': 'Lyra',
  'z-ai/glm-5.3-flash': 'Nova',
  'google/gemma-4-26b-a4b-it:free': 'Atlas',
  'cohere/north-mini-code:free': 'Polaris',
}

/** The model's own readable name, whichever provider serves it. */
export function modelLabel(model: string): string {
  for (const config of Object.values(PROVIDERS)) {
    const named = config.displayNames?.[model]
    if (named !== undefined) return named
  }
  return prettyModel(model)
}

export function agentName(provider: BrainProvider, model: string): string {
  return CODENAMES[model] ?? PROVIDERS[provider].displayNames?.[model] ?? prettyModel(model)
}

/**
 * A muted two-stop gradient whose hue is a hash of the key.
 *
 * Hashed rather than assigned so a model keeps its colour across races,
 * deploys and old history rows without anyone maintaining a palette.
 */
export function agentGradient(key: string): string {
  const hue = keyHash(key) % 360
  return `linear-gradient(135deg, hsl(${hue} 35% 55%), hsl(${(hue + 40) % 360} 30% 70%))`
}
