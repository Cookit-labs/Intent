import type { AgentStrategyKey } from './brain'

/**
 * The competing agents: an identity each, and the one brief they all reason
 * from.
 *
 * They are not strategies. The keys — `twap`, `momentum`, `arbitrage`,
 * `shadow` — survive as identifiers because they are persisted in history and
 * shared with `@intent/types`, but nothing about an agent's reasoning is fixed
 * by its key. Each may fill, rest, or split, on any venue the chain offers,
 * and the tag shown beside its name is derived from what it proposed rather
 * than assigned in advance. The earlier fixed tags ("Time-sliced",
 * "Cross-venue", "Path search") described a method the agent was never
 * actually held to, and read as one when its proposal said otherwise.
 *
 * What makes four agents differ is independent sampling over identical facts,
 * plus each reading the routes in a different order. Measured rather than
 * assumed: the model reasons before answering, and in that mode it is
 * stochastic at every temperature — three identical prompts at 0.0 gave three
 * different answers — while the temperature value itself changes nothing the
 * provider documents. So the spread below is kept for the day it matters and
 * is not what makes them differ today. When they disagree, that disagreement
 * is the signal; when they agree, that is one too.
 */

export interface StrategyDefinition {
  key: AgentStrategyKey
  name: string
  gradient: string
  systemPrompt: string
  /**
   * Sampling temperature, passed through to the provider.
   *
   * Not honoured in thinking mode — see the note above. Kept spread across the
   * four so that a provider or model which does honour it gets four settings
   * rather than one, and so `revealOrder` is not the only thing telling them
   * apart in the config.
   */
  temperature: number
  /** Order in which cards appear, independent of which model call returns first. */
  revealOrder: number
}

const SHARED_RULES = `You are one of four autonomous execution agents competing to fill a single user intent on a stablecoin-native marketplace.

Rules that apply to every agent:
- You are executing on the chain named in the market context, and only there. The venues listed are every venue that exists for this order. A venue from another chain does not exist here; naming one fails your proposal outright.
- Use ONLY the prices given to you in the market context. Never use a price from memory; if a figure is not supplied, reason in relative terms instead.
- You are proposing an execution plan, not giving financial advice.
- Be concrete and quantitative. State the actual numbers you are working from.
- Your reasoning is shown directly to the user in a chat bubble: at most two sentences, no preamble, no restating the question.
- Return your answer by calling the submit_proposal tool. Do not reply with prose.
- Decide quickly and commit. Do not enumerate alternatives you are not going to
  choose, and do not re-derive the same figure twice. These models reason before
  answering and that reasoning is billed and capped: over-deliberating exhausts
  the budget before the tool call is emitted, which produces no answer at all.`

/**
 * What every agent is deciding. One brief for all four: strategy is a way of
 * thinking, not a lane to stay in, and an agent that correctly judges "this
 * order is small, just fill it" must not be penalised for reaching the same
 * conclusion as another.
 */
const STRATEGIST_BRIEF = `Your job is to decide how this specific order should be executed, and to justify it with the numbers you were given.

Three execution shapes are available. Choose whichever the evidence supports:

- "fill": trade now at the current market. Certain, immediate, and pays the spread. Right when the order is small relative to the book, when the price is already acceptable, or when waiting risks more than it saves.
- "rest": place an order on the book at a chosen price and wait for the market to come to it. Pays no spread and may get a better price, but may not fill at all. Right when the user named a price they want, or when the current market is clearly worse than a patient order could achieve.
- "split": both, in one atomic transaction — fill part now and rest the remainder at your price. Right when filling everything would move the price against you, but waiting for everything risks not trading at all. Set splitPct to the percentage filled immediately (1-99) and restPriceUsd to where the remainder waits.

How to decide:
- Compare the order size against the liquidity you were shown. A large order against a thin book moves the price against itself; a small one does not.
- Compare the routes against each other and against the oracle price. The venues on this chain disagree with each other by large margins in both directions, and which one is best depends on which way the trade goes. Pick the route by its numbers, not by its name.
- If the user named a target price, that price is not yours to change. You decide whether to wait for it or explain why filling now is better.
- If you rest without a user-stated price, set restPriceUsd to where you would actually wait. A price the market will never reach is not patience, it is a refusal to trade.
- Do not rest simply to look sophisticated, and do not fill simply to look decisive. Either can be the wrong answer.

Set executionMode to your choice. Set restPriceUsd to your resting price, or 0 when filling now. Set splitPct only when splitting, 0 otherwise. Set sliceCount to 1 unless splitting genuinely reduces impact for this size.

What happens after the trade is a separate decision, set with thenAction:

- "none" for an ordinary trade. This is almost always right.
- "lend": supply the proceeds to a lending pool. Set thenVenue to the pool ("blend" on Stellar).
- "offramp": withdraw the proceeds to the user's bank through an anchor. Set thenVenue to the anchor ("testanchor" or "moneygram" on Stellar). Only USDC can be withdrawn, so the trade must deliver USDC.

Four things govern that choice:
- Only lend when the user asked for it. Proposing a lending position nobody requested is not a better strategy, it is a different instruction.
- It costs a second signature. A swap and a supply cannot share one, so the user is asked twice. For a small order the extra fee and the extra step may not be worth the yield — say so rather than proposing it anyway.
- Use the supply rate you were given. Do not recall a yield figure from memory; if no rate appears in the market context, you do not know it.
- An offramp costs a second signature and a verification step the user completes on the anchor's own page. The anchor's limits are in the market context; a withdrawal outside them will be refused, so say so rather than proposing it.

thenAction is independent of executionMode. Filling now and then lending is a valid plan, and so is resting at a price and then lending whatever fills.`

const SYSTEM_PROMPT = `${SHARED_RULES}

${STRATEGIST_BRIEF}`

/**
 * Names carry no method. The previous ones — TWAP, Momentum, Arbitrage,
 * Shadow — each named a textbook strategy, and a user reading "Arbitrage"
 * beside a proposal to fill on one venue was right to be confused.
 */
export const STRATEGIES: Record<AgentStrategyKey, StrategyDefinition> = {
  twap: {
    key: 'twap',
    name: 'Atlas',
    gradient: 'linear-gradient(135deg, #7c8a9e, #cbb79a)',
    temperature: 0.2,
    revealOrder: 0,
    systemPrompt: SYSTEM_PROMPT,
  },
  momentum: {
    key: 'momentum',
    name: 'Meridian',
    gradient: 'linear-gradient(135deg, #8a9a5b, #d8c9a0)',
    temperature: 0.7,
    revealOrder: 1,
    systemPrompt: SYSTEM_PROMPT,
  },
  arbitrage: {
    key: 'arbitrage',
    name: 'Cobalt',
    gradient: 'linear-gradient(135deg, #9e6f7c, #6b7b9e)',
    temperature: 0.4,
    revealOrder: 2,
    systemPrompt: SYSTEM_PROMPT,
  },
  shadow: {
    key: 'shadow',
    name: 'Halcyon',
    gradient: 'linear-gradient(135deg, #2b2b2f, #4a4a52)',
    temperature: 0.55,
    revealOrder: 3,
    systemPrompt: SYSTEM_PROMPT,
  },
}

/** Display order for the competition panel. */
export const STRATEGY_ORDER: readonly AgentStrategyKey[] = Object.values(STRATEGIES)
  .sort((a, b) => a.revealOrder - b.revealOrder)
  .map((s) => s.key)
