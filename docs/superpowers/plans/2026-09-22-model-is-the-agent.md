# Model Is The Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every configured model is its own competing agent; the roster length is the number of agents, and identity, history and leaderboard are keyed by model.

**Architecture:** A pure identity module derives key, name and colour from `provider + model`. The registry turns `AGENT_BRAINS` into an ordered roster of agents, each with its own brain. The compete route iterates the roster and the client learns the line-up from the opening stream frame, so no seat table exists anywhere. Roster pages read the live roster from a small API route and rank agents by wins counted from the user's own history.

**Tech Stack:** Next.js 14 app router, React 18, TypeScript strict, vitest (node environment, no DOM), prettier, eslint via `next lint`. All paths below are relative to `apps/dapp` unless they start with `docs/`.

**Spec:** `docs/superpowers/specs/2026-09-22-model-is-the-agent-design.md`

## Global Constraints

- Agent key format is `provider:resolvedModelId`, exactly one colon between provider and model, model part unmodified.
- `@intent/types` (`packages/types`) is not touched.
- The proposal tool schema and `validateProposal` are not touched.
- No invented statistics anywhere in the agent surface.
- Field `strategy` on proposal request, result, scored proposal and frames becomes `agent`; `ProposalRequest` also gains `seat: number` (roster index) for route rotation.
- Temperature is a single constant `0.4`; no per-agent value.
- Reveal floor for roster index `i` is `1100 + 1400 * i` milliseconds.
- Commits: conventional style, `feat(dapp): …` / `refactor(dapp): …` / `test(dapp): …`. No co-author lines. Do not stage `apps/dapp/tsconfig.json` (unrelated local change).
- Run every test command from `apps/dapp`: `npx vitest run <file>`; `npx tsc --noEmit`; `npx next lint --dir lib --dir app --dir components --dir hooks`; `npx prettier --check <files>`.
- Vitest runs in `node` with no DOM, so hooks and components have no unit tests; their logic is pushed into pure helpers that do.

---

### Task 1: Branch and land the OpenRouter provider work

**Files:**

- Commit (already modified): `.env.example`, `lib/__tests__/brain-providers.test.ts`, `lib/__tests__/registry.test.ts`, `lib/agents/brain.ts`, `lib/agents/brains/openai-compatible.ts`, `lib/agents/brains/providers.ts`, `lib/agents/evals/runner.ts`, `lib/agents/registry.ts`
- Commit (untracked): `docs/superpowers/specs/2026-09-22-model-is-the-agent-design.md`, `docs/superpowers/plans/2026-09-22-model-is-the-agent.md`

**Interfaces:**

- Produces: branch `feat/model-is-the-agent` off `feat/sep24-offramp` with the OpenRouter provider, alias table and `provider/model` roster grammar committed.

- [ ] **Step 1: Create the branch from the current head**

```bash
cd C:/Users/owner/Projects/Intent-restore
git checkout -b feat/model-is-the-agent
```

- [ ] **Step 2: Confirm the OpenRouter suite is green before committing it**

Run: `cd apps/dapp && npx vitest run lib/__tests__/brain-providers.test.ts lib/__tests__/registry.test.ts`
Expected: 22 passed.

- [ ] **Step 3: Commit the provider work**

```bash
cd C:/Users/owner/Projects/Intent-restore
git add apps/dapp/.env.example apps/dapp/lib/__tests__/brain-providers.test.ts apps/dapp/lib/__tests__/registry.test.ts apps/dapp/lib/agents/brain.ts apps/dapp/lib/agents/brains/openai-compatible.ts apps/dapp/lib/agents/brains/providers.ts apps/dapp/lib/agents/evals/runner.ts apps/dapp/lib/agents/registry.ts
git commit -m "feat(dapp): OpenRouter as a provider, five curated free models, provider/model roster entries"
```

- [ ] **Step 4: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-09-22-model-is-the-agent-design.md docs/superpowers/plans/2026-09-22-model-is-the-agent.md
git commit -m "docs(dapp): model-is-the-agent design and plan"
```

---

### Task 2: Identity module

**Files:**

- Create: `lib/agents/identity.ts`
- Modify: `lib/agents/brains/providers.ts` (add `displayNames` to `ProviderConfig` and each provider)
- Modify: `lib/agents/brain.ts` (add `export type AgentKey = string` beside `BrainProvider`)
- Test: `lib/__tests__/identity.test.ts`

**Interfaces:**

- Consumes: `PROVIDERS`, `BrainProvider`.
- Produces:
  - `type AgentKey = string` (in `brain.ts`)
  - `agentKey(provider: BrainProvider, model: string): AgentKey`
  - `prettyModel(model: string): string`
  - `agentName(provider: BrainProvider, model: string): string`
  - `agentGradient(key: string): string`
  - `ProviderConfig.displayNames?: Record<string, string>`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { agentGradient, agentKey, agentName, prettyModel } from '../agents/identity'

/**
 * An agent is a model. Its key, name and colour all derive from
 * provider + model and nothing else, so the same model is the same agent in
 * every race, every history row, and every deploy.
 */

describe('agentKey', () => {
  it('is provider, colon, resolved model id', () => {
    expect(agentKey('openrouter', 'inclusionai/ling-3.0-flash-fin:free')).toBe(
      'openrouter:inclusionai/ling-3.0-flash-fin:free'
    )
    expect(agentKey('deepseek', 'deepseek-v4-flash')).toBe('deepseek:deepseek-v4-flash')
  })

  it('makes the same model on two providers two agents', () => {
    expect(agentKey('groq', 'qwen/qwen3.8-27b')).not.toBe(
      agentKey('openrouter', 'qwen/qwen3.8-27b')
    )
  })
})

describe('prettyModel', () => {
  it('drops the vendor prefix and the tag', () => {
    expect(prettyModel('qwen/qwen3.8-27b')).toBe('Qwen3.8 27B')
    expect(prettyModel('qwen3.5:latest')).toBe('Qwen3.5')
    expect(prettyModel('inclusionai/ling-3.0-flash-fin:free')).toBe('Ling 3.0 Flash Fin')
  })

  it('upper-cases version and size tokens', () => {
    expect(prettyModel('deepseek-v4-flash')).toBe('Deepseek V4 Flash')
    expect(prettyModel('nvidia/nemotron-3-super-120b-a12b:free')).toBe('Nemotron 3 Super 120B A12B')
  })
})

describe('agentName', () => {
  it('prefers the curated display name', () => {
    expect(agentName('deepseek', 'deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(agentName('openrouter', 'inclusionai/ling-3.0-flash-fin:free')).toBe(
      'Ling 3.0 Flash Fin'
    )
  })

  it('falls back to the prettified id for a raw model', () => {
    expect(agentName('openrouter', 'google/gemma-4-31b-it:free')).toBe('Gemma 4 31B It')
  })
})

describe('agentGradient', () => {
  it('is a CSS gradient that is stable for a key', () => {
    const a = agentGradient('deepseek:deepseek-v4-flash')
    expect(a).toMatch(/^linear-gradient\(135deg, hsl\(\d+ 35% 55%\), hsl\(\d+ 30% 70%\)\)$/)
    expect(agentGradient('deepseek:deepseek-v4-flash')).toBe(a)
  })

  it('differs between keys', () => {
    expect(agentGradient('deepseek:deepseek-v4-flash')).not.toBe(
      agentGradient('groq:qwen/qwen3.8-27b')
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/__tests__/identity.test.ts`
Expected: FAIL, "Failed to resolve import ../agents/identity".

- [ ] **Step 3: Add `AgentKey` and `displayNames`**

In `lib/agents/brain.ts`, directly after `export type BrainProvider = …`:

```ts
/**
 * Which agent. `provider:model`, built by `identity.ts` — an agent is a
 * model, and this is the model's name in the form every provider returns it.
 * A string rather than a union because the roster is configuration, not code.
 */
export type AgentKey = string
```

In `lib/agents/brains/providers.ts`, extend `ProviderConfig` after `aliases?`:

```ts
  /**
   * How a model is named on a card. Keyed by resolved model id; a model not
   * listed is prettified from its id, which is usually good enough and
   * occasionally wrong about capitalisation.
   */
  displayNames?: Record<string, string>
```

Add to each provider config:

```ts
  // deepseek
    displayNames: {
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-v4-pro': 'DeepSeek V4 Pro',
    },
  // groq
    displayNames: { 'qwen/qwen3.8-27b': 'Qwen3.8 27B' },
  // ollama
    displayNames: { 'qwen3.5:latest': 'Qwen3.5 (local)' },
  // openrouter
    displayNames: {
      'inclusionai/ling-3.0-flash-fin:free': 'Ling 3.0 Flash Fin',
      'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron 3 Super',
      'google/gemma-4-26b-a4b-it:free': 'Gemma 4 26B',
      'poolside/laguna-s-2.1:free': 'Laguna S 2.1',
      'cohere/north-mini-code:free': 'North Mini Code',
    },
```

- [ ] **Step 4: Write `lib/agents/identity.ts`**

```ts
import type { AgentKey, BrainProvider } from './brain'
import { PROVIDERS } from './brains/providers'

/**
 * An agent is a model. Everything that identifies one on a card, in history
 * and on the leaderboard derives from provider + model here, so the same
 * model is the same agent in every race and every deploy, and nothing is
 * assigned by hand.
 */

/** `provider:model`. The model part is the resolved id, so an alias and its id are one agent. */
export function agentKey(provider: BrainProvider, model: string): AgentKey {
  return `${provider}:${model}`
}

/**
 * A readable name from a model id.
 *
 * Ids come in three shapes — `qwen/qwen3.8-27b`, `qwen3.5:latest`,
 * `deepseek-v4-flash` — and only the middle part names the model. Version
 * and size tokens are upper-cased; everything else is capitalised.
 */
export function prettyModel(model: string): string {
  const withoutVendor = model.includes('/') ? (model.split('/').pop() ?? model) : model
  const withoutTag = withoutVendor.split(':')[0] ?? withoutVendor
  return withoutTag
    .split('-')
    .filter((t) => t !== '')
    .map((t) => (/^(v\d|\d+(\.\d+)?b$|a\d+b$)/i.test(t) ? t.toUpperCase() : capitalise(t)))
    .join(' ')
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function agentName(provider: BrainProvider, model: string): string {
  return PROVIDERS[provider].displayNames?.[model] ?? prettyModel(model)
}

/**
 * A muted two-stop gradient whose hue is a hash of the key.
 *
 * Hashed rather than assigned so a model keeps its colour across races,
 * deploys and old history rows without anyone maintaining a palette.
 */
export function agentGradient(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 35% 55%), hsl(${(hue + 40) % 360} 30% 70%))`
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/__tests__/identity.test.ts`
Expected: 8 passed. If `prettyModel('nvidia/nemotron-3-super-120b-a12b:free')` fails on `A12B`, the regex alternation `a\d+b$` handles it; check the `$` anchors are inside the group as written.

- [ ] **Step 6: Commit**

```bash
git add apps/dapp/lib/agents/identity.ts apps/dapp/lib/agents/brain.ts apps/dapp/lib/agents/brains/providers.ts apps/dapp/lib/__tests__/identity.test.ts
git commit -m "feat(dapp): agent identity derived from provider and model"
```

---

### Task 3: Agent key replaces the seat key in brain, brief, client, scoring, events

**Files:**

- Modify: `lib/agents/brain.ts` (remove `AgentStrategyKey`, `ALL_STRATEGIES`; rename `strategy` → `agent`, add `seat`)
- Create: `lib/agents/brief.ts` (from `strategies.ts`, prompt only)
- Delete: `lib/agents/strategies.ts`
- Modify: `lib/agents/brains/openai-compatible.ts`
- Modify: `lib/agents/scoring.ts`
- Modify: `lib/agents/events.ts`
- Test: `lib/__tests__/scoring.test.ts`, `lib/__tests__/brain-providers.test.ts`, `lib/__tests__/openai-compatible.test.ts`

**Interfaces:**

- Consumes: `AgentKey` from Task 2.
- Produces:
  - `ProposalRequest { intent; agent: AgentKey; seat: number; market; chain; signal? }`
  - `AgentProposalResult.agent: AgentKey`
  - `ScoredProposal.agent: AgentKey`; `pickWinner(): AgentKey | null`
  - `CompetitionStartedFrame.agents: { key: AgentKey; name: string; gradient: string; model: string }[]`
  - `CompetitionFailedFrame.agent: AgentKey`; `CompetitionWinnerFrame.winner: AgentKey`
  - `SYSTEM_PROMPT` from `lib/agents/brief.ts`

- [ ] **Step 1: Update the scoring test to the new field**

In `lib/__tests__/scoring.test.ts`: replace the import line 3 with

```ts
import type { AgentKey, AgentProposalResult } from '../agents/brain'
```

change the helper's parameter type on line 19 from `strategy: AgentStrategyKey,` to `agent: AgentKey,`, its object field on line 24 from `strategy,` to `agent,`, and every `scored[0]?.strategy` to `scored[0]?.agent`. The literal keys `'twap'`, `'shadow'` etc. stay: they are just strings now.

- [ ] **Step 2: Update the two request-building tests**

In `lib/__tests__/brain-providers.test.ts` line 33 replace `strategy: 'twap',` with

```ts
  agent: 'groq:qwen/qwen3.8-27b',
  seat: 0,
```

In `lib/__tests__/openai-compatible.test.ts` line 29 replace `strategy: 'twap',` with the same two lines, and line 84 `expect(outcome.proposal.strategy).toBe('twap')` with `expect(outcome.proposal.agent).toBe('groq:qwen/qwen3.8-27b')`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run lib/__tests__/scoring.test.ts lib/__tests__/openai-compatible.test.ts`
Expected: FAIL. Scoring: `scored[0]?.agent` is undefined. Openai-compatible: `outcome.proposal.agent` undefined, and possibly a `STRATEGIES[undefined]` TypeError from `buildMessages`.

- [ ] **Step 4: Rewrite `brain.ts` types**

Remove the `import type { AgentStrategyType } from '@intent/types'` line and the `AgentStrategyKey` type block (lines 18-22). In `ProposalRequest` replace `strategy: AgentStrategyKey` with:

```ts
agent: AgentKey
/**
 * Position in the roster. Each agent reads the routes rotated by its seat
 * so the line-up does not all anchor on the first one; nothing else about
 * the request depends on it.
 */
seat: number
```

In `AgentProposalResult` replace `strategy: AgentStrategyKey` with `agent: AgentKey`. Delete the `ALL_STRATEGIES` export at the bottom of the file.

- [ ] **Step 5: Create `lib/agents/brief.ts` and delete `strategies.ts`**

`brief.ts` holds `SHARED_RULES` and `STRATEGIST_BRIEF` verbatim from `strategies.ts` lines 33-104 with one edit: the opening sentence of `SHARED_RULES` becomes

```
You are one of several autonomous execution agents competing to fill a single user intent on a stablecoin-native marketplace.
```

Header comment for the file:

```ts
/**
 * The one brief every agent reasons from.
 *
 * There are no strategies. Each agent is a model, given identical facts and
 * this identical brief, and what makes them differ is that they are
 * different models — plus each reading the routes in a different order. When
 * they disagree, that disagreement is the signal; when they agree, that is
 * one too.
 */
```

and the export:

```ts
export const SYSTEM_PROMPT = `${SHARED_RULES}

${STRATEGIST_BRIEF}`
```

Then `git rm apps/dapp/lib/agents/strategies.ts`.

- [ ] **Step 6: Update `openai-compatible.ts`**

- Replace `import { STRATEGIES } from '../strategies'` with `import { SYSTEM_PROMPT } from '../brief'`.
- Add after `MAX_OUTPUT_TOKENS`:

```ts
/**
 * One value for every agent. The old per-seat spread (0.2–0.7) was never
 * honoured in thinking mode and is not what makes agents differ; the models
 * are. Mid-range, so a provider that does honour it is neither greedy nor
 * wild.
 */
const TEMPERATURE = 0.4
```

- In `buildMessages`: delete `const strategy = STRATEGIES[req.strategy]` and use `{ role: 'system', content: SYSTEM_PROMPT }`.
- In `routeLines`: `const shift = req.seat % Math.max(1, offered.length)`.
- In the request body: `temperature: TEMPERATURE,`.
- The two `console.warn` calls that print `${req.strategy}` print `${req.agent}`.
- The returned proposal sets `agent: req.agent,` instead of `strategy: req.strategy,`.

- [ ] **Step 7: Update `scoring.ts`**

Replace the import with `import type { AgentKey, AgentProposalResult } from './brain'`. `ScoredProposal.strategy` → `agent: AgentKey`. In `scoreProposals` map `agent: proposal.agent`, and the tie-break line uses `a.agent` / `b.agent`. `tieBreak(competitionId: string, agent: string)`. `pickWinner` returns `AgentKey | null` via `scored[0]?.agent ?? null`.

- [ ] **Step 8: Update `events.ts`**

Import `AgentKey` instead of `AgentStrategyKey`. Started frame: `agents: { key: AgentKey; name: string; gradient: string; model: string }[]` (model now required). Failed frame: `agent: AgentKey` instead of `strategy`. Winner frame: `winner: AgentKey`.

- [ ] **Step 9: Run the three tests**

Run: `npx vitest run lib/__tests__/scoring.test.ts lib/__tests__/openai-compatible.test.ts lib/__tests__/brain-providers.test.ts`
Expected: all pass.

- [ ] **Step 10: Commit** (typecheck still fails elsewhere; that is Tasks 4-7)

```bash
git add -A apps/dapp/lib/agents/brain.ts apps/dapp/lib/agents/brief.ts apps/dapp/lib/agents/strategies.ts apps/dapp/lib/agents/brains/openai-compatible.ts apps/dapp/lib/agents/scoring.ts apps/dapp/lib/agents/events.ts apps/dapp/lib/__tests__/scoring.test.ts apps/dapp/lib/__tests__/brain-providers.test.ts apps/dapp/lib/__tests__/openai-compatible.test.ts
git commit -m "refactor(dapp): agent key replaces the seat key; one brief, one temperature, seat-rotated routes"
```

---

### Task 4: Roster registry

**Files:**

- Modify: `lib/agents/registry.ts` (rewrite)
- Test: `lib/__tests__/registry.test.ts` (rewrite)

**Interfaces:**

- Consumes: `agentKey`, `agentName`, `agentGradient` (Task 2); `BRAINS`, `createBrain`; `PROVIDERS`, `ALL_PROVIDERS`, `OPENROUTER_MODELS`, `isBrainProvider`, `resolveModel`.
- Produces:

```ts
export interface RosterAgent {
  key: AgentKey
  name: string
  gradient: string
  provider: BrainProvider
  model: string
  brain: AgentBrain
}
export function getRoster(): RosterAgent[] | undefined
export interface PublicAgent {
  key: string
  name: string
  gradient: string
  provider: string
  providerName: string
  model: string
  free: boolean
}
export function publicRoster(roster: RosterAgent[]): PublicAgent[]
```

- [ ] **Step 1: Rewrite the registry test**

Replace `lib/__tests__/registry.test.ts` entirely:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which agents race, and what happens when none can.
 *
 * An agent is a model. `AGENT_BRAINS` lists them, one entry per agent, and
 * unset means every configured model. Nothing is padded to a fixed count and
 * nothing is substituted: a model the user named and did not get is a
 * warning, not a different agent wearing its name.
 *
 * Modules are reset between cases because each brain reads its key once, at
 * load.
 */

const KEYS = ['DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'AGENT_BRAINS'] as const

async function registry(): Promise<typeof import('../agents/registry')> {
  return import('../agents/registry')
}

describe('getRoster', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    for (const k of KEYS) delete process.env[k]
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const k of KEYS) {
      const was = saved[k]
      if (was === undefined) delete process.env[k]
      else process.env[k] = was
    }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns nothing rather than a stand-in when no provider is configured', async () => {
    const { getRoster } = await registry()
    expect(getRoster()).toBeUndefined()
  })

  it('fields one agent per configured provider default', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    const keys = (getRoster() ?? []).map((a) => a.key)
    expect(keys).toEqual(['deepseek:deepseek-v4-flash', 'groq:qwen/qwen3.8-27b'])
  })

  it('fields every curated OpenRouter model when that key is set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    const roster = getRoster() ?? []
    expect(roster).toHaveLength(5)
    expect(new Set(roster.map((a) => a.model)).size).toBe(5)
    expect(roster.every((a) => a.provider === 'openrouter')).toBe(true)
  })

  it('is seven agents with the three hosted keys', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect(getRoster()).toHaveLength(7)
  })

  it('never fields a local daemon unless named', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect((getRoster() ?? []).some((a) => a.provider === 'ollama')).toBe(false)
  })

  it('takes AGENT_BRAINS as the roster, in order, one entry per agent', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,deepseek'
    const { getRoster } = await registry()
    const roster = getRoster() ?? []
    expect(roster.map((a) => a.key)).toEqual([
      'openrouter:inclusionai/ling-3.0-flash-fin:free',
      'deepseek:deepseek-v4-flash',
    ])
    expect(roster[0]?.name).toBe('Ling 3.0 Flash Fin')
    expect(roster[0]?.brain.model).toBe('inclusionai/ling-3.0-flash-fin:free')
  })

  it('accepts a raw catalogue id after the provider', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/google/gemma-4-31b-it:free'
    const { getRoster } = await registry()
    expect(getRoster()?.[0]?.model).toBe('google/gemma-4-31b-it:free')
  })

  it('collapses an entry that resolves to an agent already listed', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] =
      'openrouter/ling-fin,openrouter/inclusionai/ling-3.0-flash-fin:free,openrouter'
    const { getRoster } = await registry()
    // The bare `openrouter` entry is its default model, which is ling-fin too.
    expect(getRoster()).toHaveLength(1)
    expect(console.warn).toHaveBeenCalled()
  })

  it('drops a named agent whose provider has no key, and says so', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin,deepseek'
    const { getRoster } = await registry()
    expect((getRoster() ?? []).map((a) => a.provider)).toEqual(['deepseek'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OPENROUTER_API_KEY'))
  })

  it('drops an unrecognised provider name the same way', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'gpt5,deepseek'
    const { getRoster } = await registry()
    expect(getRoster()).toHaveLength(1)
  })

  it('returns nothing when every named agent is dropped', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['AGENT_BRAINS'] = 'openrouter/ling-fin'
    const { getRoster } = await registry()
    expect(getRoster()).toBeUndefined()
  })

  it('gives every agent a stable colour from its key', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    const { getRoster } = await registry()
    expect(getRoster()?.[0]?.gradient).toMatch(/^linear-gradient\(/)
  })
})

describe('publicRoster', () => {
  it('exposes identity and cost, never the brain', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'test-key'
    process.env['GROQ_API_KEY'] = 'test-key'
    const { getRoster, publicRoster } = await registry()
    const rows = publicRoster(getRoster() ?? [])
    expect(rows[0]).toEqual({
      key: 'deepseek:deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      gradient: expect.stringMatching(/^linear-gradient\(/) as string,
      provider: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-v4-flash',
      free: false,
    })
    expect(rows[1]?.free).toBe(true)
    expect(Object.keys(rows[0] ?? {})).not.toContain('brain')
    delete process.env['DEEPSEEK_API_KEY']
    delete process.env['GROQ_API_KEY']
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/__tests__/registry.test.ts`
Expected: FAIL, `getRoster is not a function`.

- [ ] **Step 3: Rewrite `lib/agents/registry.ts`**

```ts
import type { AgentBrain, AgentKey, BrainProvider } from './brain'
import { BRAINS, createBrain } from './brains/openai-compatible'
import {
  ALL_PROVIDERS,
  OPENROUTER_MODELS,
  PROVIDERS,
  isBrainProvider,
  resolveModel,
} from './brains/providers'
import { agentGradient, agentKey, agentName } from './identity'

/**
 * Which agents race.
 *
 * Server-side only: every brain reads an API key, so this must be reachable
 * from route handlers and nothing else.
 *
 * An agent is a model. The roster is one entry per model, and its length is
 * the number of competitors — there are no seats to fill and nothing is
 * repeated to make up a count. Different models disagree for real reasons,
 * and that disagreement is the output this competition exists to produce;
 * two copies of one model would agree by construction.
 *
 * Returns nothing rather than a fallback when no provider is configured. A
 * mock used to stand in here, so a missing key produced agents reciting
 * canned text — proposals that carried no route, could not be signed, and
 * looked exactly like decisions somebody had made. The route now tells the
 * user the agents are not online, which is what is true.
 */

export interface RosterAgent {
  key: AgentKey
  name: string
  gradient: string
  provider: BrainProvider
  model: string
  brain: AgentBrain
}

/** What the roster looks like from outside the server: identity and cost, no brain. */
export interface PublicAgent {
  key: string
  name: string
  gradient: string
  provider: string
  providerName: string
  model: string
  free: boolean
}

/**
 * `AGENT_BRAINS` is the roster, in display order: `deepseek,openrouter/ling-fin,
 * openrouter/nemotron-super` is three agents. An entry is a provider, or a
 * provider and a model after a slash — an alias from the provider's table or
 * a raw catalogue id, which may itself contain slashes and colons; only the
 * first slash separates. A bare provider runs its default (or
 * `<PROVIDER>_MODEL`).
 *
 * An entry that cannot run is dropped with a warning, never replaced: the
 * user named a model and did not get it, and a substitute wearing a different
 * name would hide that. Two entries that resolve to one agent are one agent.
 *
 * Unset spreads over everything configured: each auto-select provider's
 * default model, and every curated OpenRouter model when that key exists.
 */
const ENV_KEY = 'AGENT_BRAINS'

function agent(provider: BrainProvider, model: string, brain: AgentBrain): RosterAgent {
  const key = agentKey(provider, model)
  return {
    key,
    name: agentName(provider, model),
    gradient: agentGradient(key),
    provider,
    model,
    brain,
  }
}

function parseEntry(entry: string): { provider: BrainProvider; model?: string } | undefined {
  const slash = entry.indexOf('/')
  const provider = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase()
  if (!isBrainProvider(provider)) return undefined
  const model = slash === -1 ? '' : entry.slice(slash + 1).trim()
  return model === '' ? { provider } : { provider, model: resolveModel(provider, model) }
}

function requestedRoster(raw: string): RosterAgent[] {
  const roster: RosterAgent[] = []
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  for (const entry of entries) {
    const ask = parseEntry(entry)
    if (ask === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} names no known provider; skipped`)
      continue
    }
    const shared = BRAINS[ask.provider]
    if (!shared.isConfigured()) {
      const env = PROVIDERS[ask.provider].apiKeyEnv
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} needs ${env}, which is not set; skipped`)
      continue
    }
    const model = ask.model ?? shared.model
    const brain = ask.model !== undefined ? createBrain({ provider: ask.provider, model }) : shared
    const next = agent(ask.provider, model, brain)
    if (roster.some((a) => a.key === next.key)) {
      // eslint-disable-next-line no-console
      console.warn(`[agents] "${entry}" in ${ENV_KEY} is ${next.key} again; one agent per model`)
      continue
    }
    roster.push(next)
  }
  return roster
}

/**
 * Every model that can run. A provider needing no key is excluded: a local
 * daemon that is not running looks exactly like one that is, right up until
 * its agent fails. Naming it in `AGENT_BRAINS` opts in.
 */
function defaultRoster(): RosterAgent[] {
  const roster: RosterAgent[] = []
  for (const provider of ALL_PROVIDERS) {
    if (!PROVIDERS[provider].autoSelect || !BRAINS[provider].isConfigured()) continue
    if (provider === 'openrouter') {
      for (const model of Object.values(OPENROUTER_MODELS)) {
        roster.push(agent(provider, model, createBrain({ provider, model })))
      }
      continue
    }
    roster.push(agent(provider, BRAINS[provider].model, BRAINS[provider]))
  }
  return roster
}

export function getRoster(): RosterAgent[] | undefined {
  const raw = process.env[ENV_KEY]
  const roster = raw !== undefined && raw.trim() !== '' ? requestedRoster(raw) : defaultRoster()

  if (roster.length === 0) {
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
  return roster
}

export function publicRoster(roster: RosterAgent[]): PublicAgent[] {
  return roster.map(({ key, name, gradient, provider, model }) => {
    const config = PROVIDERS[provider]
    const rate = config.pricing[model] ?? config.defaultPricing
    return {
      key,
      name,
      gradient,
      provider,
      providerName: config.displayName,
      model,
      free: rate.input === 0 && rate.output === 0,
    }
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/__tests__/registry.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/dapp/lib/agents/registry.ts apps/dapp/lib/__tests__/registry.test.ts
git commit -m "feat(dapp): the roster is the line-up, one agent per model"
```

---

### Task 5: Competition shapes, reveal pacing, and the compete route

**Files:**

- Modify: `lib/agents/competition.ts`
- Modify: `app/api/agents/compete/route.ts`
- Test: `lib/__tests__/competition.test.ts`

**Interfaces:**

- Consumes: `RosterAgent`, `getRoster` (Task 4); `agentGradient` (Task 2); frames (Task 3).
- Produces:

```ts
export interface CompetingAgent { key: AgentKey; name: string; gradient: string; model: string }
export interface CompetitionState { agents: CompetingAgent[]; proposals; revealed; phase; secondsLeft; winner; unanimous?; error? }   // `models` removed
export interface AgentProposalView { …; model?: string }
export function revealFloor(index: number): number
export function agentsFromProposals(proposals: Record<string, AgentProposalView>): CompetingAgent[]
```

- [ ] **Step 1: Replace the AGENTS test with pacing and restore tests**

In `lib/__tests__/competition.test.ts` replace the import on line 3 with

```ts
import { agentsFromProposals, describePlan, revealFloor } from '../agents/competition'
```

and replace the whole `describe('the agents carry identity only', …)` block with:

```ts
describe('reveal pacing', () => {
  it('keeps the first four floors where they were, then keeps stepping', () => {
    // The race used to be four fixed floors. Now it is a step per roster
    // position, so a seventh agent has a floor too rather than falling to 0.
    expect([0, 1, 2, 3].map(revealFloor)).toEqual([1100, 2500, 3900, 5300])
    expect(revealFloor(6)).toBe(9500)
  })
})

describe('a restored turn recovers its line-up', () => {
  it('builds agents from the stored proposals, colour from the key', () => {
    const agents = agentsFromProposals({
      'deepseek:deepseek-v4-flash': {
        key: 'deepseek:deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        model: 'deepseek-v4-flash',
        avgPriceUsd: 1,
        vsOraclePct: 0,
        score: 0,
      },
      twap: { key: 'twap', name: 'Atlas', avgPriceUsd: 1, vsOraclePct: 0, score: 0 },
    })
    expect(agents.map((a) => a.key)).toEqual(['deepseek:deepseek-v4-flash', 'twap'])
    expect(agents[0]?.model).toBe('deepseek-v4-flash')
    // A legacy row recorded no model; the caption is simply omitted.
    expect(agents[1]?.model).toBe('')
    expect(agents[1]?.name).toBe('Atlas')
    expect(agents[1]?.gradient).toMatch(/^linear-gradient\(/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/__tests__/competition.test.ts`
Expected: FAIL, `revealFloor is not a function` (or import resolution against the deleted strategies module).

- [ ] **Step 3: Update `lib/agents/competition.ts`**

- Imports become:

```ts
import type { AgentKey, BrainErrorCode } from './brain'
import { agentGradient } from './identity'
```

- `AgentProposalView` gains, after `name: string`:

```ts
  /** Which model this agent is. Absent on rows recorded before models were tracked. */
  model?: string
```

- `CompetitionState`: delete the `models` field and its comment; add at the top:

```ts
  /**
   * The line-up, in display order, from the opening frame. Empty until it
   * arrives. Every agent here is a model; four of them agreeing means
   * something different from four samples of one.
   */
  agents: CompetingAgent[]
```

- Replace `REVEAL_DELAYS` and its comment with:

```ts
/**
 * When card `index` may appear at the earliest, in ms from the start.
 *
 * A step per roster position rather than a fixed table, so a seventh agent
 * has a floor as well as a fourth. An agent that answers quickly still waits
 * its turn so the cards read as a race; one that answers late appears the
 * moment it can.
 */
const REVEAL_FIRST_MS = 1100
const REVEAL_STEP_MS = 1400
export function revealFloor(index: number): number {
  return REVEAL_FIRST_MS + REVEAL_STEP_MS * index
}
```

- Replace `CompetingAgent` and the `AGENTS` constant with:

```ts
export interface CompetingAgent {
  key: AgentKey
  name: string
  gradient: string
  model: string
}

/**
 * The line-up of a turn that was recorded, rebuilt from what it recorded.
 *
 * A row keeps each agent's key, name and (since models became agents) its
 * model. The colour is a function of the key, so it needs no storing.
 */
export function agentsFromProposals(
  proposals: Record<string, AgentProposalView>
): CompetingAgent[] {
  return Object.values(proposals).map((p) => ({
    key: p.key,
    name: p.name,
    gradient: agentGradient(p.key),
    model: p.model ?? '',
  }))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/__tests__/competition.test.ts`
Expected: pass.

- [ ] **Step 5: Update the compete route**

In `app/api/agents/compete/route.ts`:

- Imports: remove `AgentStrategyKey`, `ALL_STRATEGIES`, `getAgentBrains`, `STRATEGIES`, `STRATEGY_ORDER`. Add `import { getRoster } from '../../../../lib/agents/registry'`.
- Replace

```ts
  const brains = getAgentBrains()
  if (brains === undefined) {
```

with

```ts
  const roster = getRoster()
  if (roster === undefined) {
```

- The started frame:

```ts
send({
  type: 'competition:started',
  competitionId,
  // The line-up is named up front, while every card still says
  // "thinking". Each agent is a model, and the user can see which.
  agents: roster.map(({ key, name, gradient, model }) => ({ key, name, gradient, model })),
  windowSeconds: WINDOW_SECONDS,
})
```

- The race:

```ts
      const settled = await Promise.all(
        roster.map(async (agent, seat) => {
          const controllerForAgent = new AbortController()
          const timer = setTimeout(() => controllerForAgent.abort(), AGENT_TIMEOUT_MS)

          try {
            const outcome = await agent.brain.propose({
              intent,
              agent: agent.key,
              seat,
              market,
              chain,
              signal: controllerForAgent.signal,
            })

            if (!outcome.ok) {
              send({ type: 'competition:failed', competitionId, agent: agent.key, error: outcome.error })
              return undefined
            }
```

and the rest of the callback unchanged.

- Winner: `proposals.find((p) => p.agent === winner)` and `scores: Object.fromEntries(scored.map((s) => [s.agent, s.score]))`.

- [ ] **Step 6: Typecheck the server side**

Run: `npx tsc --noEmit 2>&1 | grep -E "route.ts|competition.ts|registry.ts|scoring.ts|events.ts|brain.ts"`
Expected: no lines. (Client files still fail; Task 6-7.)

- [ ] **Step 7: Commit**

```bash
git add apps/dapp/lib/agents/competition.ts apps/dapp/app/api/agents/compete/route.ts apps/dapp/lib/__tests__/competition.test.ts
git commit -m "feat(dapp): the race runs the roster; reveal floors step per agent"
```

---

### Task 6: The hook learns the line-up from the stream

**Files:**

- Modify: `hooks/use-competition.ts`

**Interfaces:**

- Consumes: `CompetingAgent`, `revealFloor`, `CompetitionState.agents` (Task 5); frames (Task 3).
- Produces: `useCompetition()` returns `agents` and no `models`.

- [ ] **Step 1: Rewrite the hook's seat references**

- Imports: remove `REVEAL_DELAYS` and the `STRATEGIES, STRATEGY_ORDER` line; add `CompetingAgent` to the type import and `revealFloor` to the value import from `../lib/agents/competition`.
- State: replace `const [models, setModels] = useState<Record<string, string>>({})` with

```ts
const [agents, setAgents] = useState<CompetingAgent[]>([])
// The same list, readable inside the stream loop's closures without a
// stale render's copy.
const agentsRef = useRef<CompetingAgent[]>([])
```

- Every `setModels({})` becomes `setAgents([])` followed by `agentsRef.current = []` (two places: the idle branch and the reset before the race).
- `markFailed`: replace the `name:` line with

```ts
                name: agentsRef.current.find((a) => a.key === key)?.name ?? key,
```

- `settle`: replace `for (const key of STRATEGY_ORDER) {` with `for (const { key, name, model } of agentsRef.current) {` and inside, the placeholder object uses `name,` and adds `model,` after it (instead of `name: STRATEGIES[key].name,`).
- Started frame:

```ts
if (frame.type === 'competition:started') {
  agentsRef.current = frame.agents
  setAgents(frame.agents)
  continue
}
```

- Failed frame: `markFailed(frame.agent, frame.error)`.
- Proposal frame: replace the first three lines of the block with

```ts
const key = frame.proposal.agent
const agent = agentsRef.current.find((a) => a.key === key)
const index = agentsRef.current.findIndex((a) => a.key === key)
const floor = revealFloor(Math.max(0, index))
```

and in the view object replace `name: STRATEGIES[key].name,` with

```ts
                  name: agent?.name ?? key,
                  ...(agent !== undefined ? { model: agent.model } : {}),
```

- Return object: replace `models,` with `agents,`.

- [ ] **Step 2: Typecheck the hook**

Run: `npx tsc --noEmit 2>&1 | grep "use-competition"`
Expected: no lines.

- [ ] **Step 3: Commit**

```bash
git add apps/dapp/hooks/use-competition.ts
git commit -m "feat(dapp): the client takes the line-up from the opening frame"
```

---

### Task 7: Panel, restored turns, intent card

**Files:**

- Modify: `components/intents/competition-panel.tsx`
- Modify: `components/intents/intent-chat.tsx:183-197`
- Modify: `components/intents/intent-card.tsx:26,51`

**Interfaces:**

- Consumes: `CompetitionState.agents`, `agentsFromProposals` (Task 5).

- [ ] **Step 1: Panel reads the state's agents**

In `competition-panel.tsx`:

- Import line: `import { describePlan } from '../../lib/agents/competition'` (drop `AGENTS`).
- Destructure: `const { proposals, revealed, agents, phase, winner, error } = state`.
- `const revealedAgents = agents.filter((a) => revealed[a.key])` and `const pendingAgents = decided ? [] : agents.filter((a) => !revealed[a.key])`.
- Both model captions: `shortModel(agent.model)` in place of `shortModel(models[agent.key])` (four occurrences, two per caption).

- [ ] **Step 2: Restored turns rebuild their line-up**

In `intent-chat.tsx` add `agentsFromProposals` to the import from `../../lib/agents/competition` (there is an existing import of `CompetitionState`-adjacent names from that module; if none exists add `import { agentsFromProposals } from '../../lib/agents/competition'`). In the restored branch replace

```ts
          models: {},
```

and its comment with

```ts
          agents: agentsFromProposals(restored.proposals),
```

- [ ] **Step 3: Intent card stops counting to four**

In `intent-card.tsx` delete `const COMPETING_AGENTS = 4` and change the case to

```ts
    case 'competition':
      return 'Competing'
```

- [ ] **Step 4: Typecheck and lint the whole app**

Run: `npx tsc --noEmit` then `npx next lint --dir lib --dir app --dir components --dir hooks`
Expected: both clean. Remaining errors should only be in `components/agents/*` and `lib/agent-roster.ts` (Task 9) and `lib/agents/evals/runner.ts` (Task 10); fix anything else here.

- [ ] **Step 5: Commit**

```bash
git add apps/dapp/components/intents/competition-panel.tsx apps/dapp/components/intents/intent-chat.tsx apps/dapp/components/intents/intent-card.tsx
git commit -m "feat(dapp): cards render whatever line-up raced"
```

---

### Task 8: Roster API route

**Files:**

- Create: `app/api/agents/roster/route.ts`

**Interfaces:**

- Consumes: `getRoster`, `publicRoster` (Task 4).
- Produces: `GET /api/agents/roster` → `{ agents: PublicAgent[] }`.

- [ ] **Step 1: Write the route**

`publicRoster` is unit-tested in Task 4; the route is a one-line adapter.

```ts
import { NextResponse } from 'next/server'

import { getRoster, publicRoster } from '../../../../lib/agents/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The line-up as the directory shows it: identity and cost, no keys.
 *
 * The roster is configuration on the server, so a client page cannot know
 * it any other way. Empty when nothing is configured, which the page says.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ agents: publicRoster(getRoster() ?? []) })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep roster/route`
Expected: no lines.

- [ ] **Step 3: Commit**

```bash
git add apps/dapp/app/api/agents/roster/route.ts
git commit -m "feat(dapp): roster endpoint for the agents directory"
```

---

### Task 9: Leaderboard from real races, directory from the roster

**Files:**

- Create: `lib/agents/leaderboard.ts`
- Delete: `lib/agent-roster.ts`
- Modify: `components/agents/agent-leaderboard.tsx` (rewrite)
- Modify: `components/agents/agent-directory.tsx` (rewrite `AgentRow` and `AgentDirectory`; keep `RegisterCard`)
- Test: `lib/__tests__/leaderboard.test.ts`

**Interfaces:**

- Consumes: `ChatTurn`, `loadTurns`, `syncTurns`, `onTurnsChanged`; `PublicAgent` (Task 4); `useChain().slug`, `useChainHref()`, `AgentAvatar`.
- Produces:

```ts
export interface LeaderboardRow {
  key: string
  name: string
  races: number
  wins: number
  winRate: number
}
export function rankAgents(turns: ChatTurn[]): LeaderboardRow[]
```

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/leaderboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { ChatTurn } from '../chat-history'
import { rankAgents } from '../agents/leaderboard'

/**
 * The leaderboard counts what happened. A race is a turn in which the agent
 * proposed; a win is a turn it was picked as best. Nothing is invented, so
 * an agent that never raced is not on the board.
 */

function turn(
  id: string,
  winner: string | null,
  proposals: Record<string, { name: string; failed?: 'timeout' }>
): ChatTurn {
  return {
    id,
    chain: 'stellar',
    text: 'swap',
    createdAt: '2026-09-22T00:00:00.000Z',
    winner,
    proposals: Object.fromEntries(
      Object.entries(proposals).map(([key, p]) => [
        key,
        {
          key,
          name: p.name,
          avgPriceUsd: 1,
          vsOraclePct: 0,
          score: 0,
          ...(p.failed ? { failed: p.failed } : {}),
        },
      ])
    ),
  }
}

describe('rankAgents', () => {
  it('counts races and wins per agent, most wins first', () => {
    const rows = rankAgents([
      turn('1', 'deepseek:deepseek-v4-flash', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'groq:qwen/qwen3.8-27b': { name: 'Qwen3.8 27B' },
      }),
      turn('2', 'groq:qwen/qwen3.8-27b', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'groq:qwen/qwen3.8-27b': { name: 'Qwen3.8 27B' },
      }),
      turn('3', 'deepseek:deepseek-v4-flash', {
        'deepseek:deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
      }),
    ])
    expect(rows).toEqual([
      {
        key: 'deepseek:deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        races: 3,
        wins: 2,
        winRate: 2 / 3,
      },
      { key: 'groq:qwen/qwen3.8-27b', name: 'Qwen3.8 27B', races: 2, wins: 1, winRate: 0.5 },
    ])
  })

  it('does not count a failed proposal as a race', () => {
    const rows = rankAgents([
      turn('1', 'twap', {
        twap: { name: 'Atlas' },
        shadow: { name: 'Halcyon', failed: 'timeout' },
      }),
    ])
    expect(rows).toEqual([{ key: 'twap', name: 'Atlas', races: 1, wins: 1, winRate: 1 }])
  })

  it('breaks a tie on wins by races, then name', () => {
    const rows = rankAgents([
      turn('1', null, { b: { name: 'Bravo' }, a: { name: 'Alpha' } }),
      turn('2', null, { b: { name: 'Bravo' } }),
    ])
    expect(rows.map((r) => r.key)).toEqual(['b', 'a'])
  })

  it('is empty with no turns', () => {
    expect(rankAgents([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/__tests__/leaderboard.test.ts`
Expected: FAIL, cannot resolve `../agents/leaderboard`.

- [ ] **Step 3: Write `lib/agents/leaderboard.ts`**

```ts
import type { ChatTurn } from '../chat-history'

/**
 * Standing computed from the races that actually ran.
 *
 * The board used to show reputation, volume and fill counts that were typed
 * in. Now it shows two numbers per agent, both counted from the user's own
 * history: how many races it proposed in, and how many it was picked as best.
 * Small numbers, but real ones.
 */
export interface LeaderboardRow {
  key: string
  name: string
  races: number
  wins: number
  winRate: number
}

export function rankAgents(turns: ChatTurn[]): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>()

  for (const turn of turns) {
    for (const view of Object.values(turn.proposals)) {
      if (view.failed !== undefined) continue
      const row = rows.get(view.key) ?? {
        key: view.key,
        name: view.name,
        races: 0,
        wins: 0,
        winRate: 0,
      }
      row.races += 1
      if (turn.winner === view.key) row.wins += 1
      // The latest name wins; a curated display name may have changed.
      row.name = view.name
      rows.set(view.key, row)
    }
  }

  return [...rows.values()]
    .map((r) => ({ ...r, winRate: r.races === 0 ? 0 : r.wins / r.races }))
    .sort((a, b) => b.wins - a.wins || b.races - a.races || a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/__tests__/leaderboard.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Rewrite the leaderboard component**

Replace `components/agents/agent-leaderboard.tsx`:

```tsx
'use client'

import { cn } from '@intent/ui'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { LeaderboardRow } from '../../lib/agents/leaderboard'
import { rankAgents } from '../../lib/agents/leaderboard'
import { agentGradient } from '../../lib/agents/identity'
import { loadTurns, onTurnsChanged, syncTurns } from '../../lib/chat-history'
import { useChain, useChainHref } from '../../providers/chain-provider'
import { AgentAvatar } from './agent-avatar'

/**
 * Agents ranked by races won, counted from this user's own history.
 *
 * Reads the local cache first so the board does not blank, then syncs from
 * the server and re-renders on any later change.
 */
export function AgentLeaderboard(): JSX.Element {
  const { slug } = useChain()
  const chainHref = useChainHref()
  const [rows, setRows] = useState<LeaderboardRow[]>(() => rankAgents(loadTurns(slug)))

  useEffect(() => {
    setRows(rankAgents(loadTurns(slug)))
    void syncTurns(slug).then((turns) => setRows(rankAgents(turns)))
    return onTurnsChanged(() => setRows(rankAgents(loadTurns(slug))))
  }, [slug])

  if (rows.length === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-sm">
        No races yet. Run an intent and the agents that answer appear here.
      </div>
    )
  }

  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div className="border-border text-muted-foreground grid grid-cols-[2rem_1fr_5rem_5rem_5rem] items-center gap-4 border-b px-5 py-3 text-xs sm:grid-cols-[2rem_1fr_6rem_6rem_6rem]">
        <span>#</span>
        <span>Agent</span>
        <span className="text-right">Wins</span>
        <span className="text-right">Races</span>
        <span className="text-right">Win rate</span>
      </div>
      {rows.map((row, i) => (
        <Link
          key={row.key}
          href={chainHref(`/agents/${encodeURIComponent(row.key)}`)}
          className={cn(
            'border-border grid grid-cols-[2rem_1fr_5rem_5rem_5rem] items-center gap-4 px-5 py-4 transition-colors last:border-b-0 sm:grid-cols-[2rem_1fr_6rem_6rem_6rem]',
            'hover:bg-muted/40 border-b',
            i === 0 && 'border-foreground/30 border-l-2'
          )}
        >
          <span
            className={cn(
              'text-sm tabular-nums',
              i === 0 ? 'text-foreground font-semibold' : 'text-muted-foreground'
            )}
          >
            {i + 1}
          </span>
          <div className="flex min-w-0 items-center gap-3">
            <AgentAvatar gradient={agentGradient(row.key)} name={row.name} className="h-8 w-8" />
            <span className="text-foreground truncate text-sm font-medium">{row.name}</span>
          </div>
          <span className="text-foreground text-right text-sm font-semibold tabular-nums">
            {row.wins}
          </span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">{row.races}</span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">
            {Math.round(row.winRate * 100)}%
          </span>
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Rewrite the directory to read the roster**

In `components/agents/agent-directory.tsx` replace the imports, `Stat`, `AgentRow` and `AgentDirectory` (keep `RegisterCard` verbatim):

```tsx
'use client'

import { Plus, Terminal } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { PublicAgent } from '../../lib/agents/registry'
import { useChainHref } from '../../providers/chain-provider'
import { AgentAvatar } from './agent-avatar'

function AgentRow({ agent }: { agent: PublicAgent }): JSX.Element {
  const chainHref = useChainHref()
  return (
    <Link
      href={chainHref(`/agents/${encodeURIComponent(agent.key)}`)}
      className="border-border hover:border-foreground/40 flex flex-col gap-4 rounded-xl border p-5 transition-colors"
    >
      <div className="flex items-center gap-3">
        <AgentAvatar gradient={agent.gradient} name={agent.name} className="h-10 w-10" />
        <div className="flex flex-1 flex-col">
          <span className="text-foreground text-sm font-semibold">{agent.name}</span>
          <span className="text-muted-foreground text-xs">via {agent.providerName}</span>
        </div>
        <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
          {agent.free ? 'free' : 'paid'}
        </span>
      </div>
      <span className="text-muted-foreground truncate font-mono text-xs">{agent.model}</span>
    </Link>
  )
}

type Roster =
  | { status: 'loading' }
  | { status: 'ready'; agents: PublicAgent[] }
  | { status: 'failed'; message: string }

export function AgentDirectory(): JSX.Element {
  const [roster, setRoster] = useState<Roster>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch('/api/agents/roster')
      .then(async (res) => {
        if (!res.ok) throw new Error(`roster failed (${res.status})`)
        return (await res.json()) as { agents: PublicAgent[] }
      })
      .then((body) => {
        if (!cancelled) setRoster({ status: 'ready', agents: body.agents })
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setRoster({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {roster.status === 'loading' ? (
        <div className="text-muted-foreground text-sm">Loading the roster…</div>
      ) : roster.status === 'failed' ? (
        <div className="text-muted-foreground text-sm">
          Could not load the roster: {roster.message}
        </div>
      ) : roster.agents.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          No agents configured. Set a provider key.
        </div>
      ) : (
        roster.agents.map((agent) => <AgentRow key={agent.key} agent={agent} />)
      )}
      <RegisterCard />
    </div>
  )
}
```

`RegisterCard` stays exactly as it is, between `AgentRow` and `AgentDirectory`.

- [ ] **Step 7: Delete the invented roster**

```bash
git rm apps/dapp/lib/agent-roster.ts
```

Then `grep -rn "agent-roster" apps/dapp --include=*.ts --include=*.tsx` must print nothing.

- [ ] **Step 8: Typecheck, lint, prettier**

Run: `npx tsc --noEmit` then `npx next lint --dir lib --dir app --dir components --dir hooks` then `npx prettier --write components/agents lib/agents/leaderboard.ts lib/__tests__/leaderboard.test.ts`
Expected: tsc clean except `lib/agents/evals/runner.ts` (Task 10); lint clean.

- [ ] **Step 9: Commit**

```bash
git add -A apps/dapp/lib/agents/leaderboard.ts apps/dapp/lib/__tests__/leaderboard.test.ts apps/dapp/components/agents/agent-leaderboard.tsx apps/dapp/components/agents/agent-directory.tsx apps/dapp/lib/agent-roster.ts
git commit -m "feat(dapp): directory from the live roster, leaderboard from real races"
```

---

### Task 10: Eval runner samples a model instead of seating it

**Files:**

- Modify: `lib/agents/evals/runner.ts`

**Interfaces:**

- Consumes: `ProposalRequest.agent`/`seat`, `agentKey`.

- [ ] **Step 1: Replace the seat loop with samples**

- Imports: drop `ALL_STRATEGIES` and `AgentStrategyKey`; add `import { agentKey } from '../identity'`.
- Add near the top: `const SAMPLES = 4` with the comment:

```ts
/**
 * How many times each case is asked of the model under test.
 *
 * Four samples, four seats, so each reads the routes in a different order —
 * the same spread a race gives one model. Distinctness across samples says
 * whether the model varies its reasoning or repeats itself.
 */
```

- `CaseResult.strategy: AgentStrategyKey` → `seat: number`.
- `hardChecks(p, ctx)` drops its first parameter and the four seat rules (`TWAP must slice`, `Momentum must not slice`, `Arbitrage horizon over 5m`, `Shadow must state…`). The injection checks stay.
- In `main`: `const agent = agentKey(provider, model)`; the log line reads `samples: ${SAMPLES}` and `total calls: ${golden.cases.length * SAMPLES}`; the loop is

```ts
    const outcomes = await Promise.all(
      Array.from({ length: SAMPLES }, (_, seat) => seat).map(async (seat): Promise<CaseResult> => {
```

with `brain.propose({ intent, agent, seat, market, chain: 'arc', signal })`, `base` carrying `seat,`, `hardChecks(outcome.proposal, {…})`, and `${okCount}/${SAMPLES} clean`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean across the whole app.

- [ ] **Step 3: Commit**

```bash
git add apps/dapp/lib/agents/evals/runner.ts
git commit -m "refactor(dapp): eval runner samples one model four times, no seat rules"
```

---

### Task 11: Configuration docs, full verification, PR

**Files:**

- Modify: `.env.example` (AGENT_BRAINS comment block)
- Modify: `lib/agents/brains/providers.ts` (Groq comment "One agent, not four" → roster wording; OpenRouter limits line)

- [ ] **Step 1: Rewrite the AGENT_BRAINS block in `.env.example`**

Replace the comment lines above `AGENT_BRAINS=…` and the value with:

```
# The line-up. One entry per agent, in display order; the number of entries is
# the number of agents that race. An entry is a provider, or provider/model
# where model is a short name from the provider's table or a raw catalogue id.
# Leave unset to race every configured model: each provider's default plus all
# five curated OpenRouter models when that key is set (seven with the three
# hosted keys). Groq holds one agent: its free tier allows 8,000 tokens a
# minute and one prompt costs ~2,300. An entry whose key is missing is dropped
# with a warning, never swapped.
# AGENT_BRAINS=deepseek,groq,openrouter/ling-fin,openrouter/nemotron-super,openrouter/gemma-4
```

and in the OpenRouter block replace the `AGENT_BRAINS=openrouter/…` example line with the same example, and the limits sentence with: `# Seven agents is seven requests a race: ten races a day untopped, two hundred after.`

- [ ] **Step 2: Providers comment**

In the Groq doc comment change `**One agent, not four.**` to `**One agent.**` and `Four concurrent agents therefore ask for ~9,200` stays as the measurement. In the OpenRouter comment, the sentence starting `A competition is four requests` becomes `The default roster puts five agents here, so a race is five requests: ten races a day on an untopped key, then every OpenRouter agent reports \`rate_limited\` until midnight UTC.`

- [ ] **Step 3: Full verification**

Run, from `apps/dapp`:

```bash
npx vitest run
npx tsc --noEmit
npx next lint --dir lib --dir app --dir components --dir hooks
npx prettier --check "lib/agents/**/*.ts" "lib/__tests__/*.test.ts" "components/agents/*.tsx" "components/intents/competition-panel.tsx" "components/intents/intent-card.tsx" "components/intents/intent-chat.tsx" "hooks/use-competition.ts" "app/api/agents/**/*.ts"
npx next build
```

Expected: all tests pass (the live anchor test may flake on network; rerun alone); tsc, lint, prettier clean; build succeeds. Fix anything that fails before continuing.

- [ ] **Step 4: Grep for leftovers**

```bash
grep -rnE "STRATEGIES|STRATEGY_ORDER|ALL_STRATEGIES|AgentStrategyKey|AGENT_PROFILES|AGENT_RANKING|REVEAL_DELAYS|\.strategy\b" apps/dapp --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: no matches outside comments that describe history.

- [ ] **Step 5: Commit and push**

```bash
git add apps/dapp/.env.example apps/dapp/lib/agents/brains/providers.ts
git commit -m "docs(dapp): AGENT_BRAINS is the roster; limits for a seven-agent race"
git push -u origin feat/model-is-the-agent
```

- [ ] **Step 6: Open the PR**

Base is `feat/sep24-offramp`, the branch this work sits on (the repo stacks PRs: #30 → main, #31 → #30, offramp → #31). Retarget to `main` when the stack below merges.

```bash
gh pr create --base feat/sep24-offramp --title "feat(dapp): every model is an agent — the roster is the line-up" --body-file - <<'EOF'
## What

Agents were four fixed seats (Atlas, Meridian, Cobalt, Halcyon) sharing one brief, with models rotated into them. Now every configured model is its own agent: the roster length is the number of competitors, and identity, history and the leaderboard are keyed by model.

- OpenRouter added as a provider with five curated free models (Ling 3.0 Flash Fin, Nemotron 3 Super, Gemma 4 26B, Laguna S 2.1, North Mini Code), each verified as tool-capable against the catalogue.
- `AGENT_BRAINS` is the roster: one entry per agent, `provider` or `provider/model`. Unset races every configured model — seven with the three hosted keys.
- Identity derives from `provider:model`: curated display names, hashed colour, stable across races and history.
- The client learns the line-up from the opening stream frame; reveal floors step per agent.
- Directory reads a new `/api/agents/roster`; leaderboard counts wins from the user's own history. Invented stats deleted.
- Field `strategy` renamed `agent` through the agent layer; `@intent/types` untouched. Old history rows keep rendering.

## Limits

Seven agents is seven requests a race. OpenRouter free tier: 20/min, 50/day untopped (ten races), 1,000/day after a one-time $10 credit.

## Verification

`vitest`, `tsc --noEmit`, `next lint`, `prettier --check`, `next build` all clean. Live tool calls for the OpenRouter models are not exercised in CI; `pnpm agents:eval openrouter <alias>` scores each against the golden set once a key is present.

Spec: `docs/superpowers/specs/2026-09-22-model-is-the-agent-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 7: Record the PR URL**

Print the URL from `gh pr create` for the final report.
