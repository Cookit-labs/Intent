import type { AgentBrain, BrainProvider } from './brain'
import { mockBrain } from './brains/mock-brain'

/**
 * Picks which brain answers a competition.
 *
 * Server-side only. The DeepSeek implementation reads the API key, so it must
 * be reachable from route handlers and nothing else — see the lint rule
 * forbidding `lib/agents/brains/*` from components and hooks.
 *
 * Selection fails safe: anything other than an explicitly configured provider
 * returns the mock, so a missing key degrades to simulated agents rather than
 * a broken screen.
 */

let deepseekBrain: AgentBrain | undefined
let deepseekLoadFailed = false

/**
 * Loaded lazily so that a mock-only deployment never pulls in the `openai`
 * client or touches provider configuration at import time.
 */
function loadDeepSeek(): AgentBrain | undefined {
  if (deepseekBrain !== undefined || deepseekLoadFailed) return deepseekBrain
  try {
    // eslint-disable-next-line
    const mod = require('./brains/deepseek-brain') as { deepseekBrain: AgentBrain }
    deepseekBrain = mod.deepseekBrain
  } catch {
    // The module may not exist yet, or its dependency may be missing. Either
    // way the mock covers it.
    deepseekLoadFailed = true
  }
  return deepseekBrain
}

export function getAgentBrain(): AgentBrain {
  const configured = (process.env['AGENT_BRAIN'] ?? 'mock') as BrainProvider

  if (configured === 'deepseek') {
    const brain = loadDeepSeek()
    if (brain !== undefined && brain.isConfigured()) return brain
  }

  return mockBrain
}

/** Exposed so a route can report which brain actually served a competition. */
export function describeBrain(): { provider: BrainProvider; degraded: boolean } {
  const brain = getAgentBrain()
  return { provider: brain.id, degraded: brain.id === 'mock' }
}
