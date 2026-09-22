import type { AgentBrain, AgentKey, BrainProvider } from './brain'
import { BRAINS, createBrain } from './brains/openai-compatible'
import {
  ALL_PROVIDERS,
  OPENROUTER_MODELS,
  PROVIDERS,
  isBrainProvider,
  resolveModel,
} from './brains/providers'
import { agentGradient, agentKey, agentName } from './identity'

/**
 * Which agents race.
 *
 * Server-side only: every brain reads an API key, so this must be reachable
 * from route handlers and nothing else.
 *
 * An agent is a model. The roster is one entry per model, and its length is
 * the number of competitors — there are no seats to fill and nothing is
 * repeated to make up a count. Different models disagree for real reasons,
 * and that disagreement is the output this competition exists to produce;
 * two copies of one model would agree by construction.
 *
 * Returns nothing rather than a fallback when no provider is configured. A
 * mock used to stand in here, so a missing key produced agents reciting
 * canned text — proposals that carried no route, could not be signed, and
 * looked exactly like decisions somebody had made. The route now tells the
 * user the agents are not online, which is what is true.
 */

export interface RosterAgent {
  key: AgentKey
  name: string
  gradient: string
  provider: BrainProvider
  model: string
  brain: AgentBrain
}

/** What the roster looks like from outside the server: identity and cost, no brain. */
export interface PublicAgent {
  key: string
  name: string
  gradient: string
  provider: string
  providerName: string
  model: string
  free: boolean
}

/**
 * `AGENT_BRAINS` is the roster, in display order: `deepseek,openrouter/ling-fin,
 * openrouter/nemotron-super` is three agents. An entry is a provider, or a
 * provider and a model after a slash — an alias from the provider's table or
 * a raw catalogue id, which may itself contain slashes and colons; only the
 * first slash separates. A bare provider runs its default (or
 * `<PROVIDER>_MODEL`).
 *
 * An entry that cannot run is dropped with a warning, never replaced: the
 * user named a model and did not get it, and a substitute wearing a different
 * name would hide that. Two entries that resolve to one agent are one agent.
 *
 * Unset spreads over everything configured: each auto-select provider's
 * default model, and every curated OpenRouter model when that key exists.
 */
const ENV_KEY = 'AGENT_BRAINS'

function agent(provider: BrainProvider, model: string, brain: AgentBrain): RosterAgent {
  const key = agentKey(provider, model)
  return {
    key,
    name: agentName(provider, model),
    gradient: agentGradient(key),
    provider,
    model,
    brain,
  }
}

function parseEntry(entry: string): { provider: BrainProvider; model?: string } | undefined {
  const slash = entry.indexOf('/')
  const provider = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase()
  if (!isBrainProvider(provider)) return undefined
  const model = slash === -1 ? '' : entry.slice(slash + 1).trim()
  return model === '' ? { provider } : { provider, model: resolveModel(provider, model) }
}

function requestedRoster(raw: string): RosterAgent[] {
  const roster: RosterAgent[] = []
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  for (const entry of entries) {
    const ask = parseEntry(entry)
    if (ask === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} names no known provider; skipped`)
      continue
    }
    const shared = BRAINS[ask.provider]
    if (!shared.isConfigured()) {
      const env = PROVIDERS[ask.provider].apiKeyEnv
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} needs ${env}, which is not set; skipped`)
      continue
    }
    const model = ask.model ?? shared.model
    const brain = ask.model !== undefined ? createBrain({ provider: ask.provider, model }) : shared
    const next = agent(ask.provider, model, brain)
    if (roster.some((a) => a.key === next.key)) {
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} is ${next.key} again; one agent per model`)
      continue
    }
    roster.push(next)
  }
  return roster
}

/**
 * Every model that can run. A provider needing no key is excluded: a local
 * daemon that is not running looks exactly like one that is, right up until
 * its agent fails. Naming it in `AGENT_BRAINS` opts in.
 */
function defaultRoster(): RosterAgent[] {
  const roster: RosterAgent[] = []
  for (const provider of ALL_PROVIDERS) {
    if (!PROVIDERS[provider].autoSelect || !BRAINS[provider].isConfigured()) continue
    if (provider === 'openrouter') {
      for (const model of Object.values(OPENROUTER_MODELS)) {
        roster.push(agent(provider, model, createBrain({ provider, model })))
      }
      continue
    }
    roster.push(agent(provider, BRAINS[provider].model, BRAINS[provider]))
  }
  return roster
}

export function getRoster(): RosterAgent[] | undefined {
  const raw = process.env[ENV_KEY]
  const roster = raw !== undefined && raw.trim() !== '' ? requestedRoster(raw) : defaultRoster()

  if (roster.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[agents] no model provider configured — set one of ${ALL_PROVIDERS.filter(
        (p) => PROVIDERS[p].apiKeyEnv !== ''
      )
        .map((p) => PROVIDERS[p].apiKeyEnv)
        .join(', ')}, or name a local provider in ${ENV_KEY}`
    )
    return undefined
  }
  return roster
}

export function publicRoster(roster: RosterAgent[]): PublicAgent[] {
  return roster.map(({ key, name, gradient, provider, model }) => {
    const config = PROVIDERS[provider]
    const rate = config.pricing[model] ?? config.defaultPricing
    return {
      key,
      name,
      gradient,
      provider,
      providerName: config.displayName,
      model,
      free: rate.input === 0 && rate.output === 0,
    }
  })
}
