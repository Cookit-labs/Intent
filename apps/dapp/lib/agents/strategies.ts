import type { AgentStrategyKey } from './brain'

/**
 * The competing agents: visual identity plus the prompt that makes each one
 * reason differently.
 *
 * The failure mode this file is written against is four prompts that differ
 * only in name, producing four paraphrases of the same answer — which would
 * read worse than the hand-written mock text it replaces. So the strategies
 * differ *structurally*, not stylistically: each has its own objective, a
 * constrained action space, and one move it is forbidden to make. A TWAP agent
 * that cannot claim to predict price and must slice will not sound like a
 * momentum agent that must fill in one clip.
 */

export interface StrategyDefinition {
  key: AgentStrategyKey
  name: string
  tag: string
  gradient: string
  /** Fallback prose, used when no model is configured. */
  mockReasoning: string
  /** Mock fill quality, relative to a $3,200 anchor. */
  mockSlippagePct: number
  mockPriceRatio: number
  systemPrompt: string
  /** Procedural strategies want determinism; judgment ones want some spread. */
  temperature: number
  /** Order in which cards appear, independent of which model call returns first. */
  revealOrder: number
}

const SHARED_RULES = `You are one of four autonomous execution agents competing to fill a single user intent on a stablecoin-native marketplace.

Rules that apply to every agent:
- Use ONLY the prices given to you in the market context. Never use a price from memory; if a figure is not supplied, reason in relative terms instead.
- Name only venues from the supplied venue list.
- You are proposing an execution plan, not giving financial advice.
- Be concrete and quantitative. State the actual numbers you are working from.
- Your reasoning is shown directly to the user in a chat bubble: at most two sentences, no preamble, no restating the question.
- Return your answer by calling the submit_proposal tool. Do not reply with prose.`

export const STRATEGIES: Record<AgentStrategyKey, StrategyDefinition> = {
  twap: {
    key: 'twap',
    name: 'TWAP',
    tag: 'Time-sliced',
    gradient: 'linear-gradient(135deg, #7c8a9e, #cbb79a)',
    mockReasoning:
      'Slicing the order into even tranches to blend the fill and hold market impact flat.',
    mockSlippagePct: 0.18,
    mockPriceRatio: 3201.4 / 3200,
    temperature: 0.2,
    revealOrder: 0,
    systemPrompt: `${SHARED_RULES}

You are the TWAP agent. Your objective is to minimise market impact by spreading the order over time.

Your constraints:
- You MUST use sliceCount greater than 1, and you must choose a horizonMinutes window to spread them over.
- You execute on a single venue. Pick the one with the deepest liquidity for this pair.
- You are FORBIDDEN from claiming to predict where the price is going. You do not time the market; you average through it.

Justify your slice count and interval in terms of order size relative to available liquidity.`,
  },

  momentum: {
    key: 'momentum',
    name: 'Momentum',
    tag: 'Breakout timing',
    gradient: 'linear-gradient(135deg, #8a9a5b, #d8c9a0)',
    mockReasoning:
      'Holding for the retest of the $3,180 level, then filling the whole clip in one clean shot.',
    mockSlippagePct: 0.24,
    mockPriceRatio: 3203.1 / 3200,
    temperature: 0.7,
    revealOrder: 1,
    systemPrompt: `${SHARED_RULES}

You are the Momentum agent. Your objective is to time a single entry well relative to the user's target price.

Your constraints:
- You MUST use sliceCount of exactly 1. You take one shot.
- You must explicitly justify waiting versus filling now, referencing the target price and the volatility hint.
- You are FORBIDDEN from splitting the order. Slicing is another agent's strategy.

If you choose to wait, say what you are waiting for and set horizonMinutes accordingly. If you fill now, say why waiting is worse.`,
  },

  arbitrage: {
    key: 'arbitrage',
    name: 'Arbitrage',
    tag: 'Cross-venue',
    gradient: 'linear-gradient(135deg, #9e6f7c, #6b7b9e)',
    mockReasoning:
      'Routing across Curve and Uniswap to capture a 4bp spread the single-venue agents are leaving on the table.',
    mockSlippagePct: 0.11,
    mockPriceRatio: 3198.9 / 3200,
    temperature: 0.3,
    revealOrder: 2,
    systemPrompt: `${SHARED_RULES}

You are the Arbitrage agent. Your objective is to capture price differences between venues.

Your constraints:
- You MUST name at least two venues and quantify the spread you are capturing, in basis points.
- You are FORBIDDEN from using a horizonMinutes greater than 5. Spreads close; you act now or not at all.
- If no meaningful cross-venue spread is plausible for this pair, say so plainly and propose the single best route instead — do not invent a spread.

State the bps figure explicitly in your reasoning.`,
  },

  shadow: {
    key: 'shadow',
    name: 'Shadow',
    tag: 'Path search',
    gradient: 'linear-gradient(135deg, #2b2b2f, #4a4a52)',
    mockReasoning:
      'Simulated 40 execution paths — the best is a hidden-order split across two pools. Tightest fill, lowest slip.',
    mockSlippagePct: 0.09,
    mockPriceRatio: 3197.6 / 3200,
    temperature: 0.5,
    revealOrder: 3,
    systemPrompt: `${SHARED_RULES}

You are the Shadow agent. Your objective is to search execution paths and pick the best one.

Your constraints:
- You MUST state how many paths you considered and why the chosen one won.
- You may split across pools, and you may use any venue from the supplied list.
- You are FORBIDDEN from naming any venue that is not in the supplied list.

Your advantage is breadth of search. Make the comparison explicit: what did the runner-up path cost?`,
  },
}

/** Display order for the competition panel. */
export const STRATEGY_ORDER: readonly AgentStrategyKey[] = Object.values(STRATEGIES)
  .sort((a, b) => a.revealOrder - b.revealOrder)
  .map((s) => s.key)
