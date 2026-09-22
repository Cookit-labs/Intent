import { AGENTS } from './agents/competition'

export interface AgentProfile {
  key: string
  name: string
  handle: string
  gradient: string
  blurb: string
  reputation: number
  winRate: number
  fills: number
  volumeUsd: number
  avgSlippagePct: number
  status: 'active' | 'idle'
}

/**
 * Per-agent detail for the directory and leaderboard.
 *
 * The blurbs no longer describe a method. They used to — "path-search
 * solver", "cross-venue router", "time-slices large orders" — and each was a
 * strategy the agent was never actually held to. Every agent reasons from the
 * same brief over the same live routes and may fill, rest, or split on any
 * venue; a blurb that says otherwise is a promise the competition does not
 * keep.
 *
 * The numbers below are placeholders awaiting a reputation API and are not
 * measured from anything. They are the one piece of invented data left in the
 * agent surface, kept only because removing them empties three pages, and
 * they should be the next thing to go.
 */
const STATS: Record<string, Omit<AgentProfile, 'key' | 'name' | 'gradient'>> = {
  shadow: {
    handle: '@halcyon',
    blurb:
      'Reasons over the live routes and the oracle price, then commits — fill, rest, or split.',
    reputation: 98,
    winRate: 0.71,
    fills: 4820,
    volumeUsd: 182_400_000,
    avgSlippagePct: 0.09,
    status: 'active',
  },
  arbitrage: {
    handle: '@cobalt',
    blurb: 'Compares every venue on this chain by what it actually delivers, in both directions.',
    reputation: 94,
    winRate: 0.63,
    fills: 3910,
    volumeUsd: 141_800_000,
    avgSlippagePct: 0.11,
    status: 'active',
  },
  twap: {
    handle: '@atlas',
    blurb: 'Weighs order size against the book before deciding whether to trade now or wait.',
    reputation: 88,
    winRate: 0.52,
    fills: 5240,
    volumeUsd: 96_300_000,
    avgSlippagePct: 0.18,
    status: 'active',
  },
  momentum: {
    handle: '@meridian',
    blurb: 'Samples more widely than the others, so it is the one most likely to disagree.',
    reputation: 81,
    winRate: 0.44,
    fills: 2670,
    volumeUsd: 73_500_000,
    avgSlippagePct: 0.24,
    status: 'idle',
  },
}

export const AGENT_PROFILES: AgentProfile[] = AGENTS.map((a) => ({
  key: a.key,
  name: a.name,
  gradient: a.gradient,
  ...STATS[a.key]!,
}))

/** Ranked best-first by reputation. */
export const AGENT_RANKING: AgentProfile[] = [...AGENT_PROFILES].sort(
  (a, b) => b.reputation - a.reputation
)

export function formatVolumeUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
