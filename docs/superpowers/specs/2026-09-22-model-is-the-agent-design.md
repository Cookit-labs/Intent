# Model is the agent

**Date:** 2026-09-22
**Status:** approved in chat, pending spec review
**Scope:** `apps/dapp` agent layer, competition UI, roster pages

## Problem

The competition runs four fixed seats keyed `twap`, `momentum`, `arbitrage`,
`shadow`, named Atlas, Meridian, Cobalt, Halcyon. Every seat reasons from the
same brief; the keys are leftovers from a design where each seat had a method.
Models are assigned to seats through `AGENT_BRAINS`, so adding a model does not
add a competitor, it changes which brain sits in one of four chairs.

The intended product is the other way round: every configured model is an
agent in its own right, a free thinker judged on what it proposes, and the
number of competitors is the number of models wired in. With five OpenRouter
models added today the line-up should be seven agents in production, not four.

## Goals

- One agent per configured model. Seat count is the roster length.
- Agent identity is the model: name, colour, history and leaderboard all keyed
  by it. A model keeps its identity across races and deployments.
- No seat tables. Nothing in the codebase enumerates agents at build time.
- Roster pages show real data only: the live roster, and wins counted from the
  user's own history. No invented statistics.
- Old history rows (keyed by the four legacy names) still render.

## Non-goals

- Widening what an agent may propose. The proposal schema (fill/rest/split,
  then none/lend/offramp, venue and route from the supplied lists) is the set
  of actions the app can sign. Unchanged.
- The on-chain agent registry type in `@intent/types` (`AgentStrategyType`,
  `Agent`, `AgentStats`). Different concept, untouched.
- The agent profile page (`/agents/[id]`), which is a Slice 2 placeholder.
- Editing the roster without a redeploy.

## Design

### 1. Identity — `lib/agents/identity.ts`

Shared by server and client. Pure functions, no environment access.

```ts
export type AgentKey = string

/** `provider:resolvedModelId`. Canonical: alias and raw id give the same key. */
export function agentKey(provider: BrainProvider, model: string): AgentKey

/** Display name: provider's `displayNames[model]`, else `prettyModel(model)`. */
export function agentName(provider: BrainProvider, model: string): string

/** Deterministic muted gradient from the key. */
export function agentGradient(key: AgentKey): string
```

- Key examples: `deepseek:deepseek-v4-flash`, `groq:qwen/qwen3.8-27b`,
  `openrouter:inclusionai/ling-3.0-flash-fin:free`. The model part is the
  resolved id, so `openrouter/ling-fin` and the raw id collapse to one agent.
  The same model on two providers is two agents, deliberately: different
  serving can answer differently.
- Keys contain `/` and `:`. They are record keys and frame fields everywhere;
  the one place they enter a URL (directory link to `/agents/[id]`) uses
  `encodeURIComponent`.
- `prettyModel` strips a vendor prefix and a `:tag`, splits on `-`, title-cases
  tokens, and upper-cases tokens like `v4` and `27b`. `deepseek-v4-flash` →
  `DeepSeek V4 Flash` needs the curated entry; the fallback would give
  `Deepseek V4 Flash`. Curated names live on the provider config:

  ```ts
  displayNames?: Record<string, string>
  ```

  Populated for the three provider defaults, DeepSeek V4 Pro, and the five
  OpenRouter models.
  `OPENROUTER_MODELS` stays an alias→id map; names sit beside it.

- Gradient: FNV-1a hash of the key → hue in `[0, 360)`; two stops at
  `hsl(h 35% 55%)` and `hsl(h+40 30% 70%)`, 135°. Muted, and close to the
  existing palette. Legacy keys hash like any other, so old rows get a stable
  colour too, just not the one they used to have.

### 2. Roster — `lib/agents/registry.ts`

```ts
export interface RosterAgent {
  key: AgentKey
  name: string
  gradient: string
  provider: BrainProvider
  model: string
  brain: AgentBrain
}

/** Ordered line-up, or undefined when no provider can answer. */
export function getRoster(): RosterAgent[] | undefined
```

- `AGENT_BRAINS` is the roster: one entry per agent, in display order. Entry
  grammar is unchanged from today, `provider` or `provider/model` with model an
  alias or raw id. There is no repeat-to-fill; two entries mean two agents.
- Duplicates (same key after resolution) collapse to the first, with a
  `console.warn`. A named provider with no key is dropped with a warn, not
  swapped for another: the user named a model and did not get it, and a silent
  substitute would hide that.
- Unset or empty `AGENT_BRAINS`: one agent per configured auto-select
  provider's default model, in `ALL_PROVIDERS` order, and every entry of
  `OPENROUTER_MODELS` when `OPENROUTER_API_KEY` is set (the OpenRouter default
  model is one of them, so it is not listed twice). Groq contributes one agent
  because of its tokens-per-minute cap. Ollama never joins unless named.
  Result with the three hosted keys present: DeepSeek, Groq, five OpenRouter
  models, seven agents.
- Deleted: `STRATEGIES`, `STRATEGY_ORDER`, `AGENTS`, `ALL_STRATEGIES`,
  `AgentStrategyKey`, `StrategyDefinition`, `revealOrder`, `temperature`.
  `strategies.ts` becomes `brief.ts` exporting `SYSTEM_PROMPT` only. The text
  "one of four autonomous execution agents" becomes "one of several".
- Rename: the field `strategy` on `ProposalRequest`, `AgentProposalResult`,
  `ScoredProposal`, `CompetitionProposalFrame` and `CompetitionFailedFrame`
  becomes `agent: AgentKey`. `BrainMeta` carries `provider` and `model` only
  and is unchanged. `tieBreak`,
  `pickWinner`, `scoreProposals` take and return `AgentKey`. Nothing persisted
  carries the field name (history stores `AgentProposalView.key`), so there is
  no migration.
- `createBrain` is unchanged; `BRAINS` singletons remain for the default model
  per provider, and a named model gets its own `createBrain` as today.

### 3. Race — route, frames, hook, panel

**Route** (`app/api/agents/compete/route.ts`): `getRoster()` replaces
`getAgentBrains()`. `competition:started` sends
`agents: roster.map(({ key, name, gradient, model }) => …)`, the same shape as
today with N entries. Proposals are requested with `agent: key`; failed frames
carry `agent`. Winner and scores are keyed by `AgentKey`. `AGENT_TIMEOUT_MS`
and `WINDOW_SECONDS` unchanged.

**Frames** (`lib/agents/events.ts`): `AgentStrategyKey` → `AgentKey`;
`strategy` → `agent` on proposal and failed frames.

**Hook** (`hooks/use-competition.ts`):

- `CompetitionState` gains `agents: CompetingAgent[]`, set from the started
  frame, empty before it. `CompetingAgent` gains `model: string`, and the
  started frame's `model` becomes required. The separate `models` record on
  the state goes; the card reads the model from its agent. Placeholders,
  `markFailed`, `settle` and names come from `agents`. No import of any seat
  table.
- Reveal pacing: `revealFloor(index) = 1100 + 1400 * index` replaces
  `REVEAL_DELAYS[order]`. The first four floors are the current ones
  (1100, 2500, 3900, 5300 vs 5400 today, within tolerance); a seventh agent's
  floor is 9500ms. `planDecision` already waits for the last reveal, so the
  race closes after the final card whatever N is. `RACE_DURATION` keeps
  driving the countdown; when reveals outlast it the countdown reads 0 and the
  panel still waits for the last reveal, as it does today for a slow fourth.
- `AgentProposalView` gains optional `model: string`, filled from the started
  frame so the saved turn records which model each agent was.

**Panel** (`components/intents/competition-panel.tsx`): reads `state.agents`.
For a restored turn `intent-chat.tsx` builds `agents` from the stored
proposals: `{ key, name, model: proposal.model ?? '', gradient:
agentGradient(key) }`. The "which model answered" caption reads
`agent.model` and is omitted when empty, which is the case for legacy rows.

**Intent card** (`components/intents/intent-card.tsx`): `COMPETING_AGENTS`
constant removed; status reads "Competing".

### 4. Roster pages — real data only

**`GET /api/agents/roster`** (`app/api/agents/roster/route.ts`): returns

```ts
{
  agents: {
    key: string
    name: string
    gradient: string
    provider: string
    providerName: string
    model: string
    free: boolean
  }
  ;[]
}
```

`free` is `defaultPricing.input === 0 && output === 0` for that provider. No
keys, no base URLs. Empty array when nothing is configured.

**Directory** (`components/agents/agent-directory.tsx`): fetches the roster
on mount; each card shows name, provider display name, model id, and "free"
or "paid". Link to `/agents/${encodeURIComponent(key)}`. Empty state: "No
agents configured. Set a provider key." `lib/agent-roster.ts` is deleted with
its placeholder statistics.

**Leaderboard** (`components/agents/agent-leaderboard.tsx`): from
`loadTurns(chain)`, one row per key that appears in any turn's `proposals`:
name (from the stored view), races (turns where the key proposed and did not
fail), wins (turns where `winner === key`), win rate. Sorted by wins, then
races. Legacy keys appear under their stored names (Atlas, …). Empty state:
"No races yet." The aggregation is a pure function in
`lib/agents/leaderboard.ts` so it is testable without the DOM.

### 5. Rate limits

Seven agents is seven requests per race. Per provider:

| Provider   | Agents in default roster | Limit                                  | Races/day |
| ---------- | ------------------------ | -------------------------------------- | --------- |
| DeepSeek   | 1                        | paid, none binding                     | —         |
| Groq       | 1                        | 8k tokens/min: one agent fits          | —         |
| OpenRouter | 5                        | 20 req/min; 50/day, 1000/day topped up | 10 / 200  |

Documented in `providers.ts` and `.env.example`. A 429 is reported as
`rate_limited` and not retried, as today.

## Error handling

- No provider configured: `getRoster()` is undefined; route sends
  `competition:error` `agents_offline` as today.
- Every agent fails: `no_agent_answered` as today.
- A named model whose provider has no key: dropped with a warn; if that empties
  the roster, `agents_offline`.
- Roster endpoint on the client fails: directory shows the empty state with
  the fetch error's message; leaderboard is unaffected (local history).

## Testing

New or rewritten, all under `lib/__tests__` unless noted:

- `identity.test.ts`: key canonical across alias and raw id; same model on two
  providers differs; gradient stable and a valid CSS gradient; `prettyModel`
  cases for the three id shapes; curated names win.
- `registry.test.ts` (rewritten): default roster with each key combination;
  explicit roster order; duplicate collapse; unconfigured named provider
  dropped; empty roster → undefined.
- `scoring.test.ts`, `competition.test.ts`: field rename; `describePlan`
  unchanged.
- `leaderboard.test.ts`: aggregation over mixed legacy and model keys, failed
  proposals not counted as races, empty input.
- `roster-route.test.ts`: response shape, no secret fields, empty when none.
- Panel and hook: existing coverage is through `competition.test.ts` only;
  the hook's started-frame handling gets a test that N agents produce N
  placeholders and reveal floors grow with index.
- Eval runner: `hardChecks` seat rules ("TWAP must slice", "Momentum must not
  slice", "Arbitrage horizon", "Shadow must quote a number") contradict the
  shared brief and are removed. The runner samples the model under test four
  times per case and reports distinctness across samples as before.

## File map

| Action  | Path                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| add     | `lib/agents/identity.ts`, `lib/agents/leaderboard.ts`, `app/api/agents/roster/route.ts`                                                                                                                                                                                                                                                                                        |
| rewrite | `lib/agents/registry.ts`                                                                                                                                                                                                                                                                                                                                                       |
| delete  | `lib/agent-roster.ts`                                                                                                                                                                                                                                                                                                                                                          |
| rename  | `lib/agents/strategies.ts` → `lib/agents/brief.ts`                                                                                                                                                                                                                                                                                                                             |
| edit    | `lib/agents/brain.ts`, `brains/providers.ts`, `brains/openai-compatible.ts`, `events.ts`, `scoring.ts`, `competition.ts`, `evals/runner.ts`, `app/api/agents/compete/route.ts`, `hooks/use-competition.ts`, `components/intents/competition-panel.tsx`, `intent-card.tsx`, `intent-chat.tsx`, `components/agents/agent-directory.tsx`, `agent-leaderboard.tsx`, `.env.example` |
| tests   | as listed above                                                                                                                                                                                                                                                                                                                                                                |

## Compatibility

- History rows keyed `twap`/`momentum`/`arbitrage`/`shadow` keep rendering:
  name comes from the stored view, colour from the hash. Nothing rewrites them.
- `AGENT_BRAINS` values that work today keep working, with one behavioural
  change: a two-entry list now means two agents, not four.
- `@intent/types` unchanged. Backend and contracts do not reference the seat
  keys.
