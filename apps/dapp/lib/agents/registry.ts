import type { AgentBrain } from './brain'
import { deepseekBrain } from './brains/deepseek-brain'

/**
 * Which brain answers a competition, if any.
 *
 * Server-side only: the DeepSeek implementation reads the API key, so this
 * must be reachable from route handlers and nothing else.
 *
 * Returns `undefined` rather than a fallback when no live brain is available.
 * A mock used to stand in here, so a missing key produced four agents
 * reciting canned text — proposals that carried no route, could not be
 * signed, and looked exactly like decisions somebody had made. The route now
 * tells the user the agents are not online, which is what is true.
 *
 * Imported statically. The provider client used to be loaded lazily so that a
 * mock-only deployment never pulled it in; there is no such deployment now,
 * and a lazy `require` was also the reason the registry could not be tested
 * against a fresh environment.
 */
export function getAgentBrain(): AgentBrain | undefined {
  if (!deepseekBrain.isConfigured()) {
    // eslint-disable-next-line no-console
    console.warn('[agents] deepseek brain not configured (missing DEEPSEEK_API_KEY)')
    return undefined
  }
  return deepseekBrain
}
