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
- Return your answer by calling the submit_proposal tool. Do not reply with prose.
- Decide quickly and commit. Do not enumerate alternatives you are not going to
  choose, and do not re-derive the same figure twice. These models reason before
  answering and that reasoning is billed and capped: over-deliberating exhausts
  the budget before the tool call is emitted, which produces no answer at all.`

/**
 * What every agent is actually deciding.
 *
 * One brief, shared by all four, because strategy is a way of thinking rather
 * than a lane to stay in. Each agent previously had its own prompt forbidding
 * the others' conclusions — TWAP had to slice, Momentum was forbidden from
 * splitting, Arbitrage had to name two venues — so an agent that correctly
 * judged "this order is small, just fill it" was rejected by validation for
 * being right. The judgement was the thing being filtered out.
 *
 * They now differ through temperature and independent reasoning over identical
 * facts. When they disagree, that disagreement is a real signal.
 */
const STRATEGIST_BRIEF = `Your job is to decide how this specific order should be executed, and to justify it with the numbers you were given.

Two execution shapes are available. Choose whichever the evidence supports:

- "fill": trade now at the current market. Certain, immediate, and pays the spread. Right when the order is small relative to the book, when the price is already acceptable, or when waiting risks more than it saves.
- "rest": place an order on the book at a chosen price and wait for the market to come to it. Pays no spread and may get a better price, but may not fill at all. Right when the user named a price they want, or when the current market is clearly worse than a patient order could achieve.
- "split": both, in one atomic transaction — fill part now and rest the remainder at your price. Right when filling everything would move the price against you, but waiting for everything risks not trading at all. Set splitPct to the percentage filled immediately (1-99) and restPriceUsd to where the remainder waits.

How to decide:
- Compare the order size against the liquidity you were shown. A large order against a thin book moves the price against itself; a small one does not.
- If the user named a target price, that price is not yours to change. You decide whether to wait for it or explain why filling now is better.
- If you rest without a user-stated price, set restPriceUsd to where you would actually wait. A price the market will never reach is not patience, it is a refusal to trade.
- Do not rest simply to look sophisticated, and do not fill simply to look decisive. Either can be the wrong answer.

Set executionMode to your choice. Set restPriceUsd to your resting price, or 0 when filling now. Set splitPct only when splitting, 0 otherwise. Set sliceCount to 1 unless splitting genuinely reduces impact for this size.`

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

${STRATEGIST_BRIEF}`,
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

${STRATEGIST_BRIEF}`,
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

${STRATEGIST_BRIEF}`,
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

${STRATEGIST_BRIEF}`,
  },
}

/** Display order for the competition panel. */
export const STRATEGY_ORDER: readonly AgentStrategyKey[] = Object.values(STRATEGIES)
  .sort((a, b) => a.revealOrder - b.revealOrder)
  .map((s) => s.key)
