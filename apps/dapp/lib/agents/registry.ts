import type { AgentBrain, AgentStrategyKey, BrainProvider } from './brain'
import { ALL_STRATEGIES } from './brain'
import { BRAINS, createBrain } from './brains/openai-compatible'
import { ALL_PROVIDERS, PROVIDERS, isBrainProvider, resolveModel } from './brains/providers'

/**
 * Which model each agent runs on.
 *
 * Server-side only: every brain reads an API key, so this must be reachable
 * from route handlers and nothing else.
 *
 * Returns nothing rather than a fallback when no provider is configured. A
 * mock used to stand in here, so a missing key produced four agents reciting
 * canned text — proposals that carried no route, could not be signed, and
 * looked exactly like decisions somebody had made. The route now tells the
 * user the agents are not online, which is what is true.
 *
 * **Why a map rather than one brain.** Four calls to a single model are four
 * samples of one mind, and on a testnet where one route is plainly better they
 * converge: every agent agrees, the winner is drawn by tie-break hash, and the
 * race decides nothing. Different models disagree for real reasons — which
 * venue, whether to wait — and that disagreement is the output this
 * competition exists to produce.
 */

/**
 * `AGENT_BRAINS` assigns providers to agents in display order:
 * `deepseek,ollama,groq,deepseek` gives Atlas DeepSeek, Meridian the local
 * model, Cobalt Groq, and Halcyon DeepSeek again.
 *
 * An entry may name a model after the provider — `openrouter/ling-fin`, or a
 * raw catalogue id such as `openrouter/google/gemma-4-31b-it:free`. Without
 * it the provider's default (or `<PROVIDER>_MODEL`) is used. This is what
 * lets four agents share one OpenRouter key without sharing a mind.
 *
 * A name that is not a provider, or a provider with no key, falls back to the
 * first configured provider rather than leaving that agent silent — a
 * misspelling in an environment variable should cost variety, not an agent.
 * Unset spreads the configured providers round-robin, so adding a key changes
 * the line-up without further configuration.
 */
const ENV_KEY = 'AGENT_BRAINS'

/**
 * Providers that may be chosen for an agent without being named.
 *
 * A provider needing no key is excluded: "configured" would then be true of a
 * local daemon that is not running, and spreading agents onto it by default
 * would fail them all with nothing in the environment to explain why. Naming
 * it in `AGENT_BRAINS` opts in.
 */
function autoSelectable(): BrainProvider[] {
  return ALL_PROVIDERS.filter((p) => PROVIDERS[p].autoSelect && BRAINS[p].isConfigured())
}

interface Ask {
  provider: BrainProvider
  /** Set when the entry named one; the provider's default otherwise. */
  model?: string
}

/**
 * One `AGENT_BRAINS` entry. The provider is everything before the first
 * slash, the model everything after it — model ids carry slashes and colons
 * of their own, so only the first one separates.
 */
function parseEntry(entry: string): Ask | undefined {
  const slash = entry.indexOf('/')
  const provider = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase()
  // An unrecognised name is a typo, not an instruction. It falls through to
  // the default spread rather than failing the competition.
  if (!isBrainProvider(provider)) return undefined
  const model = slash === -1 ? '' : entry.slice(slash + 1).trim()
  return model === '' ? { provider } : { provider, model: resolveModel(provider, model) }
}

/**
 * What `AGENT_BRAINS` asks for, one entry per agent — before any of it is
 * checked against what actually has a key.
 *
 * A shorter list than there are agents repeats: `deepseek,groq` alternates.
 * Unset asks for nothing, and the caller spreads what is available instead.
 */
function requested(): (Ask | undefined)[] {
  const raw = process.env[ENV_KEY]
  if (raw === undefined || raw.trim() === '') return []

  const named = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (named.length === 0) return []

  return ALL_STRATEGIES.map((_, i) => {
    const pick = named[i % named.length]
    return pick !== undefined ? parseEntry(pick) : undefined
  })
}

/**
 * One brain per agent, or nothing at all.
 *
 * Nothing when no provider can answer — the whole competition is then offline,
 * which the route reports as such. One unusable provider among several is not
 * that case: that agent moves to one that works, because an agent with no
 * brain shows as an agent that did not answer, and less variety is a better
 * outcome than a silent card.
 */
export function getAgentBrains(): Record<AgentStrategyKey, AgentBrain> | undefined {
  const asked = requested()

  // An explicitly named provider counts even when nothing is auto-selectable:
  // `AGENT_BRAINS=ollama` with no API key anywhere is a complete and
  // deliberate configuration, not a misconfigured one.
  const usable = [
    ...new Set([
      ...asked
        .map((a) => a?.provider)
        .filter((p): p is BrainProvider => p !== undefined && BRAINS[p].isConfigured()),
      ...autoSelectable(),
    ]),
  ]

  if (usable.length === 0) {
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

  const entries = ALL_STRATEGIES.map((strategy, i) => {
    const want = asked[i]
    if (want !== undefined && BRAINS[want.provider].isConfigured()) {
      // A named model is a brain of its own; the shared one serves the default.
      const brain =
        want.model !== undefined
          ? createBrain({ provider: want.provider, model: want.model })
          : BRAINS[want.provider]
      return [strategy, brain] as const
    }
    // Round-robin so an unset or partly-invalid assignment still spreads the
    // agents across every provider that works.
    return [strategy, BRAINS[usable[i % usable.length] as BrainProvider]] as const
  })

  return Object.fromEntries(entries) as Record<AgentStrategyKey, AgentBrain>
}
