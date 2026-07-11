import type { AgentStrategyType } from '@intent/types'

import type { ParsedIntent } from './parse-intent'

export interface CompetingAgent {
  key: string
  name: string
  strategyType: AgentStrategyType
  tag: string
  reasoning: string
  slippagePct: number
  priceRatio: number
  gradient: string
  revealAt: number
}

export interface AgentProposalView {
  key: string
  name: string
  avgPriceUsd: number
  slippagePct: number
  score: number
}

// Timing mirrors the website how-it-works agent-race scene.
export const REVEAL_DELAYS = [1100, 2500, 3900, 5400] as const
export const RACE_DURATION = 6800
export const DECIDE_AT = RACE_DURATION + 600
export const WINDOW_SECONDS = 30

// priceRatio is each agent's avg fill relative to a $3,200 anchor, so the
// numbers land exactly on the reference mock when the intent targets $3,200
// and scale proportionally for any other target price.
export const AGENTS: CompetingAgent[] = [
  {
    key: 'twap',
    name: 'TWAP',
    strategyType: 'twap',
    tag: 'Time-sliced',
    reasoning:
      'Slicing the order into even tranches to blend the fill and hold market impact flat.',
    slippagePct: 0.18,
    priceRatio: 3201.4 / 3200,
    gradient: 'linear-gradient(135deg, #7c8a9e, #cbb79a)',
    revealAt: REVEAL_DELAYS[0],
  },
  {
    key: 'momentum',
    name: 'Momentum',
    strategyType: 'momentum',
    tag: 'Breakout timing',
    reasoning:
      'Holding for the retest of the $3,180 level, then filling the whole clip in one clean shot.',
    slippagePct: 0.24,
    priceRatio: 3203.1 / 3200,
    gradient: 'linear-gradient(135deg, #8a9a5b, #d8c9a0)',
    revealAt: REVEAL_DELAYS[1],
  },
  {
    key: 'arbitrage',
    name: 'Arbitrage',
    strategyType: 'arbitrage',
    tag: 'Cross-venue',
    reasoning:
      'Routing across Curve and Uniswap to capture a 4bp spread the single-venue agents are leaving on the table.',
    slippagePct: 0.11,
    priceRatio: 3198.9 / 3200,
    gradient: 'linear-gradient(135deg, #9e6f7c, #6b7b9e)',
    revealAt: REVEAL_DELAYS[2],
  },
  {
    key: 'shadow',
    name: 'Shadow',
    strategyType: 'shadow',
    tag: 'Path search',
    reasoning:
      'Simulated 40 execution paths — the best is a hidden-order split across two pools. Tightest fill, lowest slip.',
    slippagePct: 0.09,
    priceRatio: 3197.6 / 3200,
    gradient: 'linear-gradient(135deg, #2b2b2f, #4a4a52)',
    revealAt: REVEAL_DELAYS[3],
  },
]

/** Build each agent's concrete proposal for a parsed intent. */
export function buildProposals(parsed: ParsedIntent): Record<string, AgentProposalView> {
  const base = parsed.targetPriceUsd || parsed.referencePriceUsd || 3200
  const entries = AGENTS.map((a): [string, AgentProposalView] => [
    a.key,
    {
      key: a.key,
      name: a.name,
      avgPriceUsd: base * a.priceRatio,
      slippagePct: a.slippagePct,
      score: Number((100 - a.slippagePct * 20).toFixed(1)),
    },
  ])
  return Object.fromEntries(entries)
}

/** Winner = lowest slippage (best execution). */
export function winnerKey(): string {
  return [...AGENTS].sort((a, b) => a.slippagePct - b.slippagePct)[0]!.key
}
