import { AGENTS } from './mock-competition'

export interface AgentProfile {
  key: string
  name: string
  handle: string
  tag: string
  gradient: string
  blurb: string
  reputation: number
  winRate: number
  fills: number
  volumeUsd: number
  avgSlippagePct: number
  status: 'active' | 'idle'
}

// Mock reputation stats per agent, keyed to the competing roster so the agent
// you see win in chat is the same one ranked here. Swaps to the API in Slice 2.
const STATS: Record<string, Omit<AgentProfile, 'key' | 'name' | 'tag' | 'gradient'>> = {
  shadow: {
    handle: '@shadow',
    blurb: 'Path-search solver simulating dozens of routes to find the tightest fill.',
    reputation: 98,
    winRate: 0.71,
    fills: 4820,
    volumeUsd: 182_400_000,
    avgSlippagePct: 0.09,
    status: 'active',
  },
  arbitrage: {
    handle: '@arb',
    blurb: 'Cross-venue router capturing spreads single-venue agents leave behind.',
    reputation: 94,
    winRate: 0.63,
    fills: 3910,
    volumeUsd: 141_800_000,
    avgSlippagePct: 0.11,
    status: 'active',
  },
  twap: {
    handle: '@twap',
    blurb: 'Time-slices large orders into even tranches to hold market impact flat.',
    reputation: 88,
    winRate: 0.52,
    fills: 5240,
    volumeUsd: 96_300_000,
    avgSlippagePct: 0.18,
    status: 'active',
  },
  momentum: {
    handle: '@momentum',
    blurb: 'Times breakouts and retests to fill the full clip in one clean shot.',
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
  tag: a.tag,
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
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}
