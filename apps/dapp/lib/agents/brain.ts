import type { ParsedIntent } from '../parse-intent'
import type { PerpFacts } from '../perps/market-facts'

/**
 * The seam between the competition flow and whatever produces agent proposals.
 *
 * This mirrors `ChainAdapter`: one interface, several implementations, chosen at
 * the edge. The reason is the same in both cases — a mock table and a remote
 * model share no machinery, and without a common shape every caller ends up
 * branching on which one is active.
 *
 * The vendor behind this is expected to change (DeepSeek now, on cost; likely
 * something else later), so nothing outside `brains/` should know the provider
 * exists.
 */

/**
 * Which model service answered.
 *
 * More than one because four calls to a single model are four samples of one
 * mind, and they converge: on a testnet where one route is better by a wide
 * margin, all four agree, and a race whose outcome is decided by a tie-break
 * hash is not really a race. Different models disagree for real reasons, which
 * is the disagreement this competition exists to surface.
 *
 * See `brains/providers.ts` for each one's endpoint, limits and cost.
 */
export type BrainProvider = 'deepseek' | 'groq' | 'ollama' | 'openrouter'

/**
 * Which agent. `provider:model`, built by `identity.ts` — an agent is a
 * model, and this is the model's name in the form every provider returns it.
 * A string rather than a union because the roster is configuration, not code.
 */
export type AgentKey = string

/**
 * Market facts handed to the model.
 *
 * Prices are passed in rather than left to the model's memory. Recall of
 * specific figures is the weakest part of a cheap model's output, and a
 * hallucinated spot price would flow straight into a projected fill.
 */
export interface MarketContext {
  /** ISO timestamp these figures were taken. */
  asOf: string
  /** USD price per token symbol. */
  prices: Record<string, number>
  /** Venues the agent may name, already filtered to the active chain. */
  venues: { id: string; name: string; category: string }[]
  volatilityHint: 'low' | 'normal' | 'elevated'
  gasHint: 'cheap' | 'normal' | 'expensive'
  /**
   * Assets the agent may name, and what each one actually is.
   *
   * Supplied rather than assumed for the same reason prices are: a model asked
   * to recall which tokens exist will confidently invent one. It also means an
   * agent can propose buying tokenized treasuries at all — it cannot suggest an
   * asset class it was never told about.
   *
   * Only assets with a live market appear here. Etherfuse issues four bonds on
   * testnet and one of them trades; offering the rest would invite a confident
   * plan that fails at quote time.
   */
  assets?: { code: string; what: string; trust: string }[]
  /**
   * Live lending rates, when the chain has a lending integration.
   *
   * Supplied rather than recalled, for the same reason prices are: a model
   * asked to remember a yield will confidently invent one, and a fabricated
   * APY beside a real trade is worse than no figure at all. Absent on chains
   * with no lending, which is how an agent learns the option does not exist
   * rather than being told not to use it.
   */
  lending?: { venue: string; asset: string; supplyApy: number; utilisation: number }[]
  /**
   * Live withdrawal limits from the anchors this chain integrates.
   *
   * Supplied for the same reason lending rates are: an agent told the limits
   * can say "this exceeds what the anchor accepts" instead of proposing a
   * step that will be refused. Absent on chains with no anchor.
   */
  offramps?: {
    venue: string
    asset: string
    minAmount?: number
    maxAmount?: number
    feeEnabled: boolean
  }[]
  /**
   * Executable routes, already priced against real liquidity.
   *
   * The agents choose between these; they never invent one. A model is good at
   * judging which route suits an intent and bad at recalling what anything
   * costs, so the quoting happens first and deterministically, and the result
   * is handed over as fact — the same discipline already applied to `prices`.
   *
   * Empty when the pair has no route or the chain cannot execute, in which case
   * agents reason about the intent without proposing execution.
   */
  routes?: QuotedRoute[]
  /**
   * Live perpetual-futures figures: mark price, open interest, vault APY.
   *
   * Context only. Nothing in the proposal schema can express a perp, so the
   * prompt says a perp cannot be a plan step; the figures are there so an
   * agent weighing a spot trade knows what the leveraged market is doing
   * rather than inventing it. Absent when the venue could not be read.
   */
  perps?: PerpFacts
}

/**
 * A route as an agent sees it: enough to choose between options, plus the
 * opaque handle needed to execute the one that wins.
 */
export interface QuotedRoute {
  /** Stable id the agent names when picking. Not a venue label — a specific quote. */
  id: string
  source: string
  /** Human-scale figures, so the model is not asked to divide by 10^7. */
  sendAmount: string
  receiveAmount: string
  hops: number
  /**
   * The assets this route passes through, or 'direct'.
   *
   * Several routes for one pair are otherwise indistinguishable in the prompt:
   * "2 hops" twice says nothing an agent can choose on, while "via EURC"
   * against "direct" is a real difference.
   */
  via?: string
  /**
   * Caveat about what this route actually delivers, when it differs from the
   * others. Two venues quoting "USDC" may mean two different assets.
   */
  note?: string
  /**
   * False when the route can be priced but not yet signed.
   *
   * A venue can be worth comparing before it is worth executing: Soroswap's
   * quote is real liquidity and belongs in the comparison, but building it
   * needs a Soroban invocation this app does not do yet. Showing it while
   * marking it unexecutable is more honest than hiding it and claiming
   * Horizon was the only price available.
   */
  executable: boolean
  /** The quote itself, passed through untouched for execution. */
  quote: unknown
}

export interface ProposalRequest {
  intent: ParsedIntent
  agent: AgentKey
  /**
   * Position in the roster. Each agent reads the routes rotated by its seat
   * so the line-up does not all anchor on the first one; nothing else about
   * the request depends on it.
   */
  seat: number
  market: MarketContext
  /** Chain slug, so venue and settlement talk stays plausible for the chain. */
  chain: string
  /** Caller-owned cancellation; the brain must honour it. */
  signal?: AbortSignal
}

/**
 * What an agent proposes. Every field is checked after the model returns —
 * strict tool schemas constrain shape but cannot express ranges, so a
 * schema-valid 400% slippage is still possible and still has to be rejected.
 */
export interface AgentProposalResult {
  agent: AgentKey
  /**
   * The route this agent would execute, when one was offered and chosen.
   *
   * Optional: the mock brain and any chain without execution leave it unset,
   * and a proposal without a route is still a valid opinion — it just cannot
   * be signed.
   */
  routeId?: string
  /** One or two sentences, shown in the competition panel. */
  reasoning: string
  /**
   * Set by the agent, then **overwritten by the server** from the route it
   * chose whenever one was chosen. The agent's figures are accepted only as a
   * plausibility check at validation; what the user sees and what scoring
   * ranks are measured from the quote and the oracle price. A number the
   * agent reported about itself is not evidence of anything.
   */
  projectedAvgPriceUsd: number
  /** Distance from the oracle's fair value, in percent. Positive is worse. Measured, see above. */
  projectedSlippagePct: number
  /** Venue ids, validated against the ones offered in `MarketContext`. */
  venues: string[]
  /** 1 for a single fill, higher for a sliced execution. */
  sliceCount: number
  /** Self-reported, 0-1. Advisory only — it does not feed scoring. */
  confidence: number
  horizonMinutes: number
  /**
   * What this plan actually does.
   *
   * The agents used to differ only in prose: every proposal reached the same
   * builder and produced the same transaction, so choosing between them
   * changed nothing the user could see. This is the field that makes a
   * proposal a plan.
   */
  executionMode: 'fill' | 'rest' | 'split'
  /**
   * What happens to the proceeds after the trade.
   *
   * Separate from `executionMode` because how a trade executes and what
   * follows it are independent choices: an agent may fill now and then supply,
   * or rest at a price and then supply. Absent means an ordinary trade, which
   * is almost all of them.
   */
  thenAction?: 'lend' | 'offramp'
  /** Where the follow-on supplies, when there is one. */
  thenVenue?: string
  /**
   * On a split, the percentage filled immediately; the remainder rests.
   *
   * Absent on any other mode. A split is the first proposal shape that becomes
   * more than one operation, which is what lets four agents produce genuinely
   * different transactions rather than four descriptions of the same one.
   */
  splitPct?: number
  /**
   * The price to rest at, when resting.
   *
   * Absent for an immediate fill. Bounded by `resolveExecutionPlan` rather
   * than trusted: an agent naming this number is deciding whether the order
   * ever fills.
   */
  restPriceUsd?: number
}

export type BrainErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'invalid_schema'
  | 'refused'
  | 'upstream_error'
  | 'no_api_key'

export interface BrainMeta {
  provider: BrainProvider
  model: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  costUsd: number
}

/**
 * Discriminated result rather than a thrown error: a failing agent is an
 * ordinary outcome here, not an exception. One agent timing out should still
 * leave a competition with three real proposals, and that is easier to
 * guarantee when the failure is a value the caller must handle.
 */
export type ProposalOutcome =
  | { ok: true; proposal: AgentProposalResult; meta: BrainMeta }
  | { ok: false; error: BrainErrorCode; meta: BrainMeta }

export interface AgentBrain {
  id: BrainProvider
  displayName: string
  /**
   * The model this brain calls, shown beside the agent's name.
   *
   * Surfaced deliberately. When four agents run on three models, the user
   * asking "why does the same one always win" can see that they are not four
   * copies of one mind — and when they all do run on one model, that is
   * visible too rather than implied.
   */
  model: string
  /** False when required configuration is missing, so callers can pick a fallback. */
  isConfigured: () => boolean
  /**
   * One strategy per call. Four short independent calls beat a single long
   * agentic loop: failures stay isolated, results can stream as they land, and
   * short bounded reasoning is what these models do best.
   */
  propose: (req: ProposalRequest) => Promise<ProposalOutcome>
}
