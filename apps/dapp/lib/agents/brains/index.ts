import type { AgentBrain, BrainProvider } from '../brain'
import { createClaudeBrain } from './anthropic'
import { createBrain } from './openai-compatible'

/**
 * A brain for any provider: Claude through Anthropic's SDK, everything else
 * through the chat-completions client.
 */
export function brainFor(provider: BrainProvider, model?: string): AgentBrain {
  if (provider === 'anthropic') {
    return createClaudeBrain(model !== undefined ? { model } : {})
  }
  return createBrain(model !== undefined ? { provider, model } : { provider })
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
  anthropic: brainFor('anthropic'),
  deepseek: brainFor('deepseek'),
  groq: brainFor('groq'),
  ollama: brainFor('ollama'),
  openrouter: brainFor('openrouter'),
}
