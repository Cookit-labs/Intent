import type { AgentStrategyType } from '@intent/types'

import type { ParsedIntent } from './parse-intent'

export interface CompetingAgent {
  key: string
  name: string
  strategyType: AgentStrategyType
  reasoning: string
  slippagePct: number
  revealAt: number
}

export interface AgentProposalView {
  key: string
  name: string
  strategyType: AgentStrategyType
  projectedOut: string
  tokenOut: string
  slippagePct: number
  avgPriceUsd: number
  score: number
}

// Timing mirrors the website how-it-works agent-race scene.
export const REVEAL_DELAYS = [1100, 2500, 3900, 5400] as const
export const RACE_DURATION = 6800
export const DECIDE_AT = RACE_DURATION + 600
export const WINDOW_SECONDS = 30

export const AGENTS: CompetingAgent[] = [
  {
    key: 'twap',
    name: 'TWAP',
    strategyType: 'twap',
    reasoning: 'Time-slicing order flow',
    slippagePct: 0.18,
    revealAt: REVEAL_DELAYS[0],
  },
  {
    key: 'arbitrage',
    name: 'Arbitrage',
    strategyType: 'arbitrage',
    reasoning: 'Scanning venues for spread',
    slippagePct: 0.11,
    revealAt: REVEAL_DELAYS[1],
  },
  {
    key: 'momentum',
    name: 'Momentum',
    strategyType: 'momentum',
    reasoning: 'Timing entry on breakout',
    slippagePct: 0.24,
    revealAt: REVEAL_DELAYS[2],
  },
  {
    key: 'shadow',
    name: 'Shadow',
    strategyType: 'shadow',
    reasoning: 'Simulating 40 execution paths',
    slippagePct: 0.09,
    revealAt: REVEAL_DELAYS[3],
  },
]

function fmt(n: number, max = 4): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

/** Build each agent's concrete proposal for a parsed intent. */
export function buildProposals(parsed: ParsedIntent): Record<string, AgentProposalView> {
  const { escrowUsd, referencePriceUsd, input } = parsed
  const entries = AGENTS.map((a): [string, AgentProposalView] => {
    const avgPriceUsd = referencePriceUsd * (1 + a.slippagePct / 100)
    const projected = (escrowUsd / avgPriceUsd) * (1 - a.slippagePct / 100)
    const score = Number((100 - a.slippagePct * 20).toFixed(1))
    return [
      a.key,
      {
        key: a.key,
        name: a.name,
        strategyType: a.strategyType,
        projectedOut: fmt(projected),
        tokenOut: input.tokenOut,
        slippagePct: a.slippagePct,
        avgPriceUsd,
        score,
      },
    ]
  })
  return Object.fromEntries(entries)
}

/** Winner = lowest slippage (best execution). */
export function winnerKey(): string {
  return [...AGENTS].sort((a, b) => a.slippagePct - b.slippagePct)[0]!.key
}
