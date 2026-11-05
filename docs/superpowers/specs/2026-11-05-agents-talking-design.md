# Agents That Talk To Each Other: Design

Date: 2026-11-05. Status: approved by the owner on 2026-11-05.

## Intent

Today each agent answers a person's intent once, alone, and the panel compares the answers. The owner wants agents to read each other's strategies, question each other, and improve their own, in the open, in the chat, in real time, on all six chains: Stellar, Solana, Avalanche, Sui, Monad and NEAR.

The why: more competition produces better strategies, and watching agents challenge each other is the product. The person should see "Sonnet went through Jeff's strategy", "Sonnet asked Jeff a follow-up", "Jeff responded", and then each agent's final strategy.

## The owner's decisions

- All six chains.
- Layout: the talk appears inside the existing chat thread, as messages in order. Mockup A.
- No UI changes to existing bubbles, colors or layout. Build only from what exists.
- Agents may all reach the same conclusion, but that must never be hardcoded. Independent thinking is required. Different strategies are preferred, not forced.
- Talk is built first. Different trades come from work already in progress (see Dependencies).
- The talk runs 10 to 20 seconds before final strategies drop.

## Goals

1. Each agent reads the intent, reads other agents' strategies, can question them, answers questions put to it, and then decides its own final strategy.
2. The person watches this live, with motion, in the chat.
3. Works for every kind of action the race handles today (swap, supply, stake on chain modules, and Stellar's race), on all six chains.
4. Everything the person reads as an agent's words was written by that agent's model in this race.

## Non-goals

- New routes, venues or order types. See Dependencies.
- More than one round of questions.
- The person joining the talk. A note sent mid-race restarts the race, as it does today.
- Agents remembering earlier races.
- Word-by-word streaming of model output.
- Any agent signing or sending anything.

## Anti-goals: a failure even if it works

- Scripted lines, or a "reading" pill with no read behind it.
- Any step, vote, merge or prompt wording that pushes agents toward agreeing or toward differing.
- An agent's plan copied from, or rewritten into, another agent's plan by code.
- Scoring that rewards persuasion. Recommendation stays on measured numbers.
- A race that visibly runs much past 20 seconds because of talk.
- New bubble styles, colors or layouts.

## Dependencies: read before building

Other sessions are changing this code right now. Check their state before starting.

- **PR #153, `feat/chain-limit-orders`** (draft, stacked on #152). Task 9 lets agents recommend resting an order, and modifies `brief.ts`, `settle-chain-plan.ts`, `chain-routes.ts`, `market-context.ts`, `chain-race.ts`, `compete/route.ts` and `competition-panel.tsx`. It also requires that off Stellar a decided race always states one recommended strategy, which the owner asked for. Limit venues: Kamino, DeepBook, Rhea, CoW. Monad has none.
- **`feat/onchain-venues`** (no PR yet). Adds swap venues.

The owner chose talk first, so stack this work on `feat/chain-sequences` (#152) and don't wait for #153. Both touch the same files, so whichever merges second resolves the conflicts. Agents can't choose resting during talk until #153's Task 9 lands: when it does, the final turn's tool offers rest wherever a `RestOption` exists. Work in a new worktree. Never switch branches in the main checkout.

Choices per chain once both land:

| Chain | Swap routes | Rest an order |
|---|---|---|
| Stellar | Several | Yes, plus split |
| Solana | Jupiter, 1Click | Kamino |
| Sui | Cetus, 1Click, DeepBook, Momentum | DeepBook |
| Avalanche | 1Click, Uniswap, Pharaoh | CoW |
| Monad | 1Click, Uniswap | None |
| NEAR | 1Click | Rhea |

This table comes from the branches as read on 2026-11-05. Neither has merged, and no real wallet has signed on them.

## How a race runs

The clock starts when `competition:started` is sent, after routes are quoted. All of this happens inside the one request in `app/api/agents/compete/route.ts`, so there is no shared state.

1. **Each agent thinks first.** Each agent works through the intent on its own, calling the existing `propose`, with the existing prompt and tool, in parallel. It sees no other agent. Shown as it lands.
2. **Talk opens** when every agent has a first take, or at 8 seconds, whichever comes first. It needs at least two first takes, so if only one is in at 8 seconds, talk opens when the second lands. It never opens after 14 seconds, which leaves each turn at least 2 seconds. With no talk, the race still ends by 20 seconds if anyone has answered.
3. **Ask turn.** Each agent gets the intent, its own plan and the others' plans, and may ask one question of one agent, or ask nothing.
4. **Answer turn.** Only agents that were asked make a call. One call answers all of its questions.
5. **Final turn.** Each agent reads the whole talk and decides alone: keep its plan, change it, or hold off.
6. **Close at 20 seconds at the latest.** Scoring runs on final plans only.

The time left after talk opens is split evenly across the three turns. A turn ends early once all its calls return.

### Deadlines and failures

| What happens | Result |
|---|---|
| Ask call misses its turn | That agent asks nothing. No message. |
| Answer call misses its turn | A pill says the agent did not answer in time. No words invented. |
| Final call misses its turn, fails or is invalid | First take stands as its final plan. |
| First take lands after talk opened | Shown. It skips closed turns and may still make the final turn. |
| First take misses 20 seconds while another agent has answered | Counted as not answering in time, using the existing `unansweredLine`. |
| No first take at all by 20 seconds | No talk. Keep waiting up to the existing 60-second limit, as today. |
| 429 during talk | `noteRateLimited` as today. Same results as the rows above. |

Agents cannot address themselves. A question naming an unknown or failed agent is dropped.

## Speed: unproven, and task one

Measured figures in the repo:

- DeepSeek V4 Flash, first take: median 7.2s, p90 15.7s, p95 20.9s, max 26.2s (`lib/agents/evals/results`, 2026-09-08, 80 calls).
- Groq: 1.6 to 1.8s (comment in `brains/providers.ts`, undated).
- OpenRouter free models: no figures.

If talk opens at 8 seconds, each turn gets 4 seconds. A reasoning model at normal settings will miss that. Talk turns must therefore use a short prompt and a small output limit, and turn off model reasoning where the provider allows. `MAX_OUTPUT_TOKENS` says reasoning counts against the output limit, so a small limit with reasoning on returns nothing at all.

**Task one is a measurement, before any product code.** It depends on neither branch. For every model in the production roster, measure a first take and a talk-shaped prompt, in a `*.live.test.ts` file run by exact name. Record median and p90, and whether reasoning can be turned off. Use about ten calls per model, and five per OpenRouter model, because the free key's daily limit is shared with real races.

**Go:** every line-up `lineUp` can seat has at least two models with a talk p90 under 3 seconds, and first takes fast enough that talk usually opens by 14 seconds. **No-go:** stop and bring the numbers to the owner. A talk with one participant isn't a talk, and the choices then are a longer cap or a different roster.

A slow seat is still called. It keeps its first take when it misses a turn, per the table above. `lineUp` doesn't change.

## Provider limits

- OpenRouter free: 50 requests a day per key, or 1,000 a day once 10 credits have been bought, and 20 a minute. Two seats at four calls each is up to 8 requests a race, against 2 today. That is about 6 races a day on an untopped key, down from 25. Answer turns are skipped for agents nobody asked, so it can be less.
- Groq: 8,000 tokens a minute. A first take costs about 2,300. Each talk prompt must stay under about 800 tokens so one race fits comfortably.
- Nothing retries inside a race.

## Independence rules

- Each agent thinks through the intent and forms its own plan before seeing any other.
- Each agent reads the others' plans in a different order, rotated by seat, as routes already are.
- Talk prompts say: improve your own plan, and change it only if you are persuaded. They contain no instruction to agree, to reach consensus, or to differ.
- A final plan comes only from that agent's own model call. Otherwise its first take stands.
- `unanimous` stays computed from the final plans, after the fact. It is false if any agent holds off. Fix the panel's count, which today counts all answered agents.
- A test checks talk prompts for words such as "consensus" and "must differ".

## Holding off

An agent may end on "I wouldn't do this now", in its own words.

Today it can't. `validateProposal` fills a blank route with the first one offered (`tool-schema.ts:314-320`), because a blank usually means a model forgot the field. Keep that for first takes. The final turn's tool gets an explicit decision: `keep`, `change` or `hold`.

A held plan has no route, shows no Review button and gets no score. `scoreProposals` already ranks plans with nothing to sign last.

A held plan must never reach signing by another path. `intent-chat.tsx` falls back to the winner's route when an agent has none (`routesByAgent[executingKey] ?? winnerRoute`), so a held agent must not be selectable, on a live race or a reopened one. `pickWinner` must not return a held agent.

## Safety

- Agent text is untrusted when it enters another agent's prompt, because intents and route notes can carry planted instructions. The evals recorded `deepseek-v4-pro` following one. Pass every line through `promptSafe`, and label the block as what other agents said, not instructions.
- A changed final plan goes through the same checks as a first take: `validateProposal`, `settlePlan` or `settleChainPlan`, then `measured`. So a route must be one that was offered, and figures are measured by the server.
- Talk can't change the amount or tokens. Those stay the person's.
- Review stays on final cards only, and signing stays with the person. First takes have no Review, since they may change.
- Agents get no account details. Talk uses the same context lines as today.
- An agent could still state a false figure in a message. Talk prompts repeat the rule to use only given figures. Final cards show measured figures.

## What the person sees

Everything sits in the thread, in order, using existing pieces only.

| Moment | Built from |
|---|---|
| First take | `agentBubble`, `AgentAvatar`, name and model line, `describePlan` tag and reasoning. No Review. |
| "Sonnet is reading Jeff's strategy" | `systemPill`, sent when that agent's ask call starts. It names the agents whose plans that call was given. |
| Agent waiting on its model | Existing `ThinkingDots` in `agentBubble` |
| Question, answer | `agentBubble`, `AgentAvatar`, name line reading "Sonnet to Jeff" |
| "Sonnet changed its strategy" | `systemPill`, only when route, mode or decision differs from its first take |
| Final strategies | The existing cards, Review, penalties and Recommended, unchanged. Hold-off cards have no Review. |
| Late answer | `systemPill` |

Motion uses the same `motion.div` entrance as today's cards, and respects reduced motion as `ThinkingDots` does. Messages are capped at two sentences and 160 characters and pass through `tidyProse`.

Frames arriving together are shown in order, about 700ms apart. If the queue falls behind the close, the gap shrinks so final strategies stay near 20 seconds. Nothing is shown before it exists on the server.

The talk is saved with the turn on that browser, so it survives a reload and shows without animation. The backend that stores turns isn't in this repo, and this work doesn't change it, so another device sees the final cards without the talk. A reopened turn must still never offer Review on a held plan, even if the saved hold marker was lost: treat a plan with no route as held.

## Shape of the code

- `lib/agents/talk.ts`: runs the turns and deadlines with injected brains and clock. Pure enough to test without network.
- `AgentBrain` gains a talk method, implemented in `brains/openai-compatible.ts` and `brains/anthropic.ts`. `propose` and the first-take prompt stay as they are. Stellar's prompt stays pinned by hash.
- `lib/agents/events.ts`: new frames for first takes and talk lines, each with a sequence number. `competition:proposal` means a final plan. Unknown frames are already ignored by the hook.
- `hooks/use-competition.ts`: collects them. Ordering and pacing live in pure helpers beside `pacing.ts`, since vitest has no DOM.
- `components/intents/competition-panel.tsx`: renders talk above final cards.
- Analytics: outcomes and counts only, never words, matching the rule in the route. Questions asked, plans changed and holds. If this needs a schema change, leave it out of this work and say so.

## How we'll know it works

- Unit tests: turn order, every row of the failure table, first takes made before seeing other agents, no plan copied across agents, prompts free of steering words, hold-off, unanimity, and pacing.
- Extend `pnpm agents:eval`: for each golden case, record how often agents chose the same plan before and after talk, and how often a plan changed. No target is set. If talk makes agents collapse into one plan, the owner should see it. Add a case where a planted instruction arrives through another agent's message.
- A real race on each of the six chains on a preview with its own Postgres, as preview-first requires. Check that the talk reads as real, and time it.
- No claim that a chain is proven until someone signs there with a real wallet.

## If every agent holds off

Decided by the owner. PR #153 requires a recommended strategy on every decided race off Stellar, and this is the one exception, since there's nothing to recommend.

A pill says no agent would do this now, each agent's reason stays visible, and no signable card appears, on any chain. `needsDirectRoute` must stay false here, because agents did answer, and "The agents were unavailable" would be false. If the person still wants the trade, they ask again, and that runs as a normal new race.

## Provider prerequisite

The owner buys OpenRouter credits before launch, which lifts the free key to 1,000 requests a day. This work doesn't ration talk. Until then, an untopped key runs out sooner, and a 429 benches that model as today.

## Builder's calls so far

These were decided by the designer, not the owner. Change them if the build shows a better way.

- 20 seconds counts from `competition:started`, not from when the person pressed send, because quoting time varies.
- Talk opens at 8 seconds at the latest, with even turns afterward.
- One question per agent, 160 characters.
- 700ms between messages.
- Talk saved on the same browser only.
- Talk never opens after 14 seconds.
- `feat/onchain-venues` isn't required to build this. Build against whatever routes exist, and keep talk prompts short enough for Sui's four routes.
- A first take later than 20 seconds drops out, where today it has 60. About 1 in 20 DeepSeek calls would, on the September figures.
- No feature flag.
