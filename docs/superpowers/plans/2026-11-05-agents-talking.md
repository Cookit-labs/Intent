# Agents That Talk To Each Other Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents read each other's strategies, question each other and decide their own final plan, live in the chat, on all six chains, within about 20 seconds.

**Architecture:** First takes run as today. A new engine, `lib/agents/talk.ts`, then runs ask, answer and final turns under one shared deadline, inside the existing compete request. Final plans go through the existing validate, settle and measure path, and scoring runs on them. New SSE frames carry first takes and talk lines, and the panel renders them with existing components.

**Tech Stack:** Next 15 route handler, SSE, React 19, framer-motion, vitest (no DOM), OpenAI-compatible chat completions, Anthropic SDK.

**Spec:** `docs/superpowers/specs/2026-11-05-agents-talking-design.md`

## Global Constraints

- Work only in `.claude/worktrees/agents-talk`, branch `feat/agents-talk`, stacked on `feat/chain-sequences`. Never switch branches in the main checkout. Never run `pnpm install` in the worktree.
- `SYSTEM_PROMPT`, `CHAIN_BRIEF`, `SUBMIT_PROPOSAL_TOOL` and `propose` don't change. Stellar's prompt stays pinned by hash.
- No restyling. Use `agentBubble`, `systemPill`, `AgentAvatar`, `ThinkingDots`, and the existing card, tokens and layout.
- Deadlines from the clock start at `competition:started`: talk opens by 8000ms, or when the second first take lands, never after 14000ms. Everything closes at 20000ms. Messages are at most 2 sentences and 160 characters. Reveal gap is 700ms, shrinking to 150ms when behind.
- A model writes every agent word. No scripted lines, and no prompt words steering toward or away from agreement.
- Nothing is signed or sent by this work. Every final plan passes validate, settle and measure. Only the person's words set amount and tokens.
- No new dependencies. Vitest has no DOM and no BigInt literals, so logic goes in pure helpers under `lib/`.
- Commit subjects are lowercase, with the header at most 100 characters. No co-author or attribution lines. Stage files by name, never `.claude/` or `.next-verify/`. No push or deploy unless the owner asks.
- Run tests from `apps/dapp`: `npx vitest run <files> --reporter=basic --maxWorkers=3 --minWorkers=1`, always including `lib/__tests__/import-purity.test.ts` and `lib/__tests__/routes-load.test.ts`, and excluding `**/*.live.test.ts`.

## Review Focus

1. Every agent holds off on a chain and on Stellar: no signable card, no "agents were unavailable" text, no winner frame. Test in Task 5.
2. A held agent reached through the winner's-route fallback, live or reopened. Test `canReview` in Task 6.
3. A person's note arrives mid-talk: the hook cancels and its queued reveals never fire. Test the pure queue in Task 2; check by hand in Task 7.
4. A planted instruction in another agent's message or a route note. Test in Task 3 and run in Task 7.
5. An agent names itself, a failed agent or an unknown name as its target. Test in Task 3.

---

### Task 1: Measure speed, go or no-go

**Files:**

- Create: `apps/dapp/lib/agents/evals/talk-speed.ts`
- Modify: `apps/dapp/package.json` (script `agents:talk-speed`)

**Interfaces:**

- Produces: the provider settings used in Task 4, recorded in `apps/dapp/lib/agents/evals/RESULTS.md`.

- [ ] **Step 1: Write the script.** For each default-roster model, send a talk-shaped prompt of about 500 tokens with one small tool, and record milliseconds and whether a tool call came back. Try normal settings and reasoning-off settings. Reasoning-off bodies to try: DeepSeek `thinking: { type: 'disabled' }`, Groq `reasoning_effort: 'none'`, OpenRouter `reasoning: { enabled: false }`. Also record first takes through `createBrain().propose`. Calls: ten for DeepSeek and Groq, five for each OpenRouter model, two first takes per OpenRouter model. Print a table with median, p90 and answered count. No Anthropic key exists locally, so report it as not measured.
- [ ] **Step 2: Run it** from `apps/dapp`: `npx tsx --env-file=<main checkout>/apps/dapp/.env.local lib/agents/evals/talk-speed.ts`
- [ ] **Step 3: Decide.** Go when every line-up `lineUp` can seat has at least two models with a talk p90 under 3000ms. **No-go: stop and bring the numbers to the owner.**
- [ ] **Step 4: Record the table in `RESULTS.md` and commit**: `docs(dapp): measure how fast agents can talk`

### Task 2: Talk lines, wording and reveal pacing

**Files:**

- Create: `apps/dapp/lib/agents/talk-lines.ts`, `apps/dapp/lib/__tests__/agents-talk-lines.test.ts`
- Modify: `apps/dapp/lib/agents/pacing.ts`

**Interfaces:**

- Produces, in `talk-lines.ts`, with no server imports:
  - `type TalkLine = { kind: 'turn'; turn: 'ask' | 'answer' | 'final'; agents: string[] } | { kind: 'reading'; agent: string; of: string[] } | { kind: 'asked'; agent: string; to: string; text: string } | { kind: 'answered'; agent: string; to: string[]; text: string } | { kind: 'no_answer'; agent: string; to: string[] } | { kind: 'changed'; agent: string } | { kind: 'held'; agent: string }`
  - `type ThreadItem = { type: 'take'; agent: string } | { type: 'line'; line: TalkLine }`
  - `talkPill(line, nameOf: (key: string) => string): string | undefined`, for `reading`, `no_answer`, `changed` and `held`
  - `talkSpeaker(line, nameOf): string | undefined`, for `asked` and `answered`, like `Sonnet to Jeff`
  - `waitingAgents(agents: string[], items: ThreadItem[], answeredOrFailed: (key: string) => boolean): string[]`
  - `showTakes(items: ThreadItem[], phase): boolean`
  - `ALL_HELD_LINE`, `allHeld(views): boolean`
- Produces, in `pacing.ts`: `planTalkReveal(lastRevealMs: number, elapsedMs: number, closeMs?: number): number`, returning when an item shows, in ms from race start.

- [ ] **Step 1: Write the failing tests.**
  - `talkPill` on `reading` of one, two and three agents gives `Sonnet is reading Jeff's strategy`, `Sonnet is reading Jeff's and Opus's strategies`, and `Sonnet is reading Jeff's, Opus's and Ling's strategies`.
  - `talkPill` gives `Jeff did not answer in time.`, `Sonnet changed its strategy.`, `Opus would not do this now.`, and undefined for `asked`, `answered` and `turn`.
  - `talkSpeaker` gives `Sonnet to Jeff`, and `Jeff to Sonnet and Opus`.
  - `waitingAgents` lists agents with no take and no failure before any turn. During a turn it lists that turn's agents who haven't spoken yet. An agent's own `asked` or `answered` removes it from that turn. A later turn replaces the earlier one.
  - `showTakes` is true while competing, and after decided only if a `line` other than `turn` exists.
  - `allHeld` is true only if at least one view is held and every answered view is held.
  - `planTalkReveal(0, 0)` is 700. `planTalkReveal(1000, 900)` is 1700. `planTalkReveal(1000, 5000)` is 5000. With the last reveal at 19900 and elapsed 19000, the gap is 150, giving 20050. It never returns earlier than elapsed.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass, then commit**: `feat(dapp): word and pace what agents say to each other`

### Task 3: Talk prompts, tools and reading answers

**Files:**

- Create: `apps/dapp/lib/agents/talk-prompts.ts`, `apps/dapp/lib/__tests__/agents-talk-prompts.test.ts`

**Interfaces:**

- Consumes: `promptSafe`, `QuotedRoute`, `AgentProposalResult`, `describePlan`.
- Produces:
  - `interface TalkTool { name: string; description: string; parameters: Record<string, unknown> }`, and `ASK_TOOL` (`to`, `question`), `ANSWER_TOOL` (`answer`), `FINAL_TOOL` (`decision: 'keep' | 'change' | 'hold'`, `routeId`, `executionMode`, `restPriceUsd`, `splitPct`, `reasoning`). All properties are required, with `additionalProperties: false`.
  - `interface TalkFacts { chain: string; intent: string; routes: QuotedRoute[]; plans: { key: string; name: string; plan: string; reasoning: string }[] }`
  - `askPrompt(self, facts, seat)`, `answerPrompt(self, facts, questions, seat)`, `finalPrompt(self, facts, talkSoFar, seat)`, each returning `{ system: string; user: string }`
  - `readQuestion(raw, others: {key, name}[]): { to: string; text: string } | undefined`, `readAnswer(raw): string | undefined`, `readFinal(raw, allowedRouteIds): FinalChoice | undefined`, where `FinalChoice = { decision: 'keep' | 'hold'; reasoning: string } | { decision: 'change'; reasoning: string; routeId: string; executionMode: 'fill' | 'rest' | 'split'; restPriceUsd: number; splitPct: number }`

- [ ] **Step 1: Write the failing tests.**
  - No prompt or tool description matches `/consensus|agree|unanimous|must differ|must disagree|be different/i`.
  - Each prompt tells the agent to improve its own plan and change it only if persuaded.
  - A plan or route note holding a newline and `ignore previous instructions` arrives on one line, inside a block labelled as what others said and not instructions, capped by `promptSafe`.
  - Other plans appear in a different order for seat 0 and seat 1.
  - With four routes and four plans at maximum length, `system` plus `user` is at most 3200 characters, which is about 800 tokens.
  - `readQuestion` returns undefined for an empty question, its own name, or an unknown name. It matches a name case-insensitively, tidies dashes, and clips to 160 characters on a sentence.
  - `readFinal` returns undefined for an unknown decision, and for `change` with a blank or unoffered route. A `hold` needs no route. `reasoning` is tidied and clipped.
  - The chain final prompt says one fill. The Stellar one offers fill, rest and split.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, reusing `tidyProse` and `clipReasoning`.
- [ ] **Step 4: Run them and see them pass, then commit**: `feat(dapp): tell agents what the others said, without steering them`

### Task 4: The engine and the model call

**Files:**

- Create: `apps/dapp/lib/agents/talk.ts`, `apps/dapp/lib/__tests__/agents-talk.test.ts`, `apps/dapp/lib/__tests__/agents-talk-brain.test.ts`
- Modify: `apps/dapp/lib/agents/brain.ts`, `brains/openai-compatible.ts`, `brains/anthropic.ts`, `brains/providers.ts`

**Interfaces:**

- Consumes: Tasks 2 and 3, and Task 1's provider settings.
- Produces:
  - In `brain.ts`: `AgentBrain.talk?: (req: TalkCall) => Promise<TalkOutcome>`, with `TalkCall = { agent: AgentKey; system: string; user: string; tool: TalkTool; signal?: AbortSignal }` and `TalkOutcome = { ok: true; args: unknown; meta: BrainMeta } | { ok: false; error: BrainErrorCode; meta: BrainMeta; retryAfterMs?: number }`. Optional, so fake brains stay valid.
  - In `brain.ts`: `AgentProposalResult.held?: true`.
  - In `providers.ts`: `ProviderConfig.talk?: { body?: Record<string, unknown>; maxTokens?: number }`.
  - In `talk.ts`: `TALK_OPEN_MS = 8000`, `TALK_LATEST_OPEN_MS = 14000`, `TALK_CLOSE_MS = 20000`, and:

```ts
runTalk(input: {
  seats: { key: string; name: string; talk: NonNullable<AgentBrain['talk']> }[]
  takes: Promise<AgentProposalResult | undefined>[] // same order as seats
  facts: Omit<TalkFacts, 'plans'>
  startedAt: number
  emit: (line: TalkLine) => void
  applyFinal: (agent: string, choice: FinalChoice) => AgentProposalResult | undefined
  closeLateTakes: () => void // aborts first takes still running, called at close if anyone answered
  onRateLimited: (agent: string, retryAfterMs: number | undefined) => void
}): Promise<{ finals: AgentProposalResult[]; talked: boolean; questions: number; changed: number; held: number }>
```

- [ ] **Step 1: Write failing engine tests**, with `vi.useFakeTimers()` and fake brains.
  - The first prompt each agent sees for its take has no other plan. Assert `talk` is called only after takes land.
  - Order: `turn ask`, `reading`, `asked`, `turn answer`, `answered`, `turn final`, then `changed` or `held`.
  - Talk opens at once when all takes are in, at 8000ms with two in, and when the second lands at 12000ms. It doesn't open if the second lands after 14000ms, and `talked` is false.
  - Only asked agents make an answer call. One call answers two questions, `to` listing both.
  - A late ask emits nothing. A late answer emits `no_answer`. A late, failed or unreadable final keeps the first take, and no `changed` appears.
  - A take landing after talk opened skips closed turns and still gets the final turn.
  - `keep` emits no `changed`. `change` emits `changed` only if route or mode differs. `hold` emits `held`.
  - All calls abort, and `runTalk` resolves, by 20000ms with slow brains. `closeLateTakes` is called at 20000ms if anyone answered, and not if nobody did. With nobody at 20000ms, it waits for the takes and returns with no talk.
  - A 429 calls `onRateLimited`, and the agent keeps its take.
  - A final plan object comes only from that agent's own `applyFinal` call or first take: a test where one agent's words name another's route leaves other agents' plans untouched.
- [ ] **Step 2: Write failing brain tests**, with `fetchImpl`.
  - `talk` posts the given tool, `tool_choice: 'auto'`, the provider's `talk.body`, and `talk.maxTokens`.
  - It returns parsed args. It reports `timeout` on abort, `rate_limited` with `retryAfterMs` on 429, and `invalid_schema` on prose. It never logs the key.
  - The Anthropic `talk`, with a faked client, sends `effort: 'low'`.
- [ ] **Step 3: Run them and see them fail.**
- [ ] **Step 4: Implement.** In `openai-compatible.ts`, share the request and error handling with `propose` rather than copying it. `propose`'s body must stay byte-identical.
- [ ] **Step 5: Run them, with existing brain tests, and see them pass, then commit**: `feat(dapp): let agents question each other under one deadline`

### Task 5: The race route, scoring and holding off

**Files:**

- Modify: `apps/dapp/app/api/agents/compete/route.ts`, `lib/agents/events.ts`, `lib/agents/scoring.ts`, `lib/agents/settle-chain-plan.ts` (stale comment only)
- Create: `apps/dapp/lib/agents/talk-final.ts`, `apps/dapp/lib/__tests__/agents-talk-route.test.ts`

**Interfaces:**

- Consumes: `runTalk`, `FinalChoice`, `toOutcome`, `settlePlan`, `settleChainPlan`, `measured`.
- Produces:
  - Frames `CompetitionTakeFrame { type: 'competition:take'; competitionId; proposal }` and `CompetitionTalkFrame { type: 'competition:talk'; competitionId; line: TalkLine }`. They arrive in order on one stream, so no sequence number is needed.
  - `applyFinalChoice(first: AgentProposalResult, rawFirst: AgentProposalResult, choice: FinalChoice, ctx): AgentProposalResult | undefined`. `keep` returns `first` with new reasoning. `hold` returns `first` without `routeId`, resting or follow-on fields, with `held: true`, new reasoning, and figures zeroed. `change` rebuilds from `rawFirst` with the new route, mode and `venues: [route.source]`, then passes through `toOutcome`, settle and measure.
  - `pickWinner` never returns a held agent, and returns null if all are held. `unanimousChoice` is false if any is held.

- [ ] **Step 1: Write failing route tests**, using the setup in `agents-chain-compete.test.ts`, for near and for stellar.
  - A roster of fake brains without `talk` gives the same frames as today.
  - With two talking brains: `competition:take` frames before talk, `competition:proposal` only for final plans and only after talk, and scoring on finals.
  - A `change` to an unoffered route keeps the first take. A `change` to an offered route sends that route and measured figures.
  - All hold: `competition:proposal` frames with `held: true`, no route, no winner frame, the race recorded with a null winner, and no error frame.
  - Some hold: the winner is a non-held agent and `unanimous` is false.
  - `competition:take` carries no route.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Talk runs when at least two rostered brains have `talk`, otherwise the path stays as today. Keep each agent's `AbortController` so `closeLateTakes` can abort it. Analytics: look at `RaceInput`. If counts fit without a schema change, add `questions`, `changed` and `held`. Otherwise leave them out and say so in the report. Correct the stale comment in `settle-chain-plan.ts`.
- [ ] **Step 4: Run them with `agents-chain-compete`, `compete-route-log`, `agents-chain-race`, `registry` and the Stellar prompt-hash test, and see them pass, then commit**: `feat(dapp): race on final plans after the agents have talked`

### Task 6: Hook, panel, saving

**Files:**

- Modify: `apps/dapp/hooks/use-competition.ts`, `components/intents/competition-panel.tsx`, `components/intents/intent-chat.tsx`, `lib/agents/competition.ts`, `lib/agents/chain-race.ts`, `lib/chat-history.ts`
- Create: `apps/dapp/lib/__tests__/agents-talk-review.test.ts`

**Interfaces:**

- Consumes: Task 2 helpers, and Task 5 frames.
- Produces:
  - `CompetitionState.thread?: ThreadItem[]`, `CompetitionState.takes?: Record<string, AgentProposalView>`, `AgentProposalView.held?: true`, `ChatTurn.talk?: { thread: ThreadItem[]; takes: Record<string, AgentProposalView> }`.
  - `canReview(view: AgentProposalView | undefined, route: unknown, restored: boolean): boolean`, in `chain-race.ts`.

- [ ] **Step 1: Write failing tests.**
  - `canReview` is false for a held view, live or restored. It is false restored with no route, and true live with no route on a non-held view, as today.
  - `syncTurns` keeps a local `talk` when the server's copy has none. `saveTurnRemote`'s body has no `talk`.
  - Reveal: a queue built from `planTalkReveal` keeps frame order and final cards land after the last talk item.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the hook.** Takes and lines go through one queue using `schedule`, so cancelling clears them. In a talk race, final cards reveal after the queue, 400ms apart. The winner waits for them through `planDecision`.
- [ ] **Step 4: Implement the panel.** Render the thread above the final cards as the spec's table says. No Review on a take. Dots from `waitingAgents`. The Broadcasting pill shows only when nothing is in the thread. Held cards show their reasoning and tag `Would not do this now`, without figures or Review. Show `ALL_HELD_LINE` when `allHeld`. Exclude held from the `All N agents agree` count. No new class names beyond what's already there.
- [ ] **Step 5: Wire `intent-chat.tsx`.** Guard `handleExecute` with `canReview`. Pass the thread from a restored turn. Save `talk` with the turn.
- [ ] **Step 6: Run tests and `npx tsc --noEmit`, then commit**: `feat(dapp): show agents talking in the chat`

### Task 7: Eval and whole-branch verification

**Files:**

- Create: `apps/dapp/lib/agents/evals/talk-eval.ts`
- Modify: `apps/dapp/package.json` (script `agents:eval:talk`), `apps/dapp/lib/agents/evals/RESULTS.md`, `apps/dapp/.env.example` only if a setting was added

**Interfaces:**

- Consumes: `runTalk`, golden set, `createBrain`.

- [ ] **Step 1: Write the eval.** For golden cases, run first takes and talk across given models. Report how often all first takes chose the same plan, how often all final plans did, how many plans changed, and how many held. No target is set. Add a case where a planted instruction arrives in another agent's plan, and report whether any model obeyed.
- [ ] **Step 2: Run it** on three cases plus the injection case with DeepSeek and Groq only, to protect the OpenRouter limit. Record the results in `RESULTS.md`.
- [ ] **Step 3: Run format, lint, typecheck and all non-live tests.** Compare any failures against the base branch and say which ones are new.
- [ ] **Step 4: Run the app locally** and trigger a real race, at least on NEAR and Stellar. Time it, and capture what the talk reads like. Nothing gets signed.
- [ ] **Step 5: Run a fresh whole-branch review**, fix findings, and commit: `docs(dapp): record how talk changes what agents decide`
- [ ] **Step 6: Report** to the owner: what ran, what didn't, and what needs them (credits, a preview with its own Postgres, a real wallet).
