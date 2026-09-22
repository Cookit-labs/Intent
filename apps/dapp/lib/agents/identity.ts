import type { AgentKey, BrainProvider } from './brain'
import { PROVIDERS } from './brains/providers'

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

export function agentName(provider: BrainProvider, model: string): string {
  return PROVIDERS[provider].displayNames?.[model] ?? prettyModel(model)
}

/**
 * A muted two-stop gradient whose hue is a hash of the key.
 *
 * Hashed rather than assigned so a model keeps its colour across races,
 * deploys and old history rows without anyone maintaining a palette.
 */
export function agentGradient(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 35% 55%), hsl(${(hue + 40) % 360} 30% 70%))`
}
