# Agent Competition on Every Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A swap, supply or stake typed on NEAR, Solana, Sui, Avalanche or Monad runs the same agent competition as Stellar, and the winning plan is signed through that chain's existing safety checks.

**Architecture:** `/api/agents/compete` gets a second branch for non-Stellar chains. It takes a `ChainActionRequest` rather than a `ParsedIntent`, asks a per-chain `quoteChainRoutes()` for priced routes, and streams the same frames, so the panel is unchanged. A route's `quote` is `{ kind: 'chain', request, venueId }`. Review calls the existing `chainAction.prepare`, so `assertSafe`, signing and submit all apply. Avalanche and Monad gain a `ChainModule` with one venue, 1Click.

**Tech Stack:** Next 15, TypeScript, vitest, viem and wagmi, NEAR Intents 1Click REST.

**Spec:** None written. The requirement is the user's "agentic competition on all chain" (2026-11-04). The research is in this plan's Facts section.

## Facts this plan rests on

Live dry quotes, $5, 2026-11-04, on `https://1click.chaindefuser.com/v0/quote`:

| Chain     | USDC to native                   | Native to USDC | 1Click tokens    |
| --------- | -------------------------------- | -------------- | ---------------- |
| NEAR      | HTTP 201                         | HTTP 201       | 39               |
| Solana    | HTTP 201                         | HTTP 201       | 22               |
| Sui       | HTTP 201                         | HTTP 201       | SUI, USDC        |
| Avalanche | HTTP 201                         | HTTP 201       | AVAX, USDC, USDT |
| Monad     | HTTP 201                         | HTTP 201       | MON, USDC, USDT0 |
| Stellar   | HTTP 400 `Incorrect depositMode` | same           | not used here    |

Routes each chain will have:

| Chain     | Swap            | Supply                              | Stake            |
| --------- | --------------- | ----------------------------------- | ---------------- |
| NEAR      | 1Click          | 1Click Earn                         | Meta Pool, rNEAR |
| Solana    | Jupiter, 1Click | Jupiter Lend, Kamino, Lulo with key | none             |
| Sui       | Cetus, 1Click   | NAVI                                | SpringSui        |
| Avalanche | 1Click          | none                                | none             |
| Monad     | 1Click          | none                                | none             |

## Global Constraints

- Stellar's competition, swap, sequence and limit paths do not change. Every new branch tests `chain !== 'stellar'`.
- No edits to `components/intents/naira-payout-card.tsx`, `bank-picker.tsx` or `hooks/use-naira-payout.ts`.
- Agents choose a route id only. They never supply an amount, a recipient or a token (`tool-schema.ts` already has none).
- Race quotes must be `dry: true`. A deposit address is created only when the user presses Review. One press, one address.
- Every signed payload goes through `prepareChainAction` and then `venue.assertSafe`. Chain routes must never reach `useSwapExecution`.
- One route still races, as the user asked, and the panel says "One route available on {chain}. The agents are judging whether it's worth taking."
- On non-Stellar chains `executionMode` is forced to `fill`, `thenAction` to `none`. `rest` and `split` are not offered.
- No new dependencies. Commit subjects lowercase, header at most 100 characters, no co-author lines, no attribution footer.
- Disk is nearly full (about 7 GB free): do not start a second dev server or `next build`. Use vitest and `tsc --noEmit`.
- Work on a new branch `feat/agents-every-chain`, created from `feat/multichain-wallet-gate` with `git switch -c`, which changes no files and leaves the user's dev server running.

## Review Focus

- A token the chain doesn't list, such as "swap 5 FOO to USDC" on Solana: no race, no agent calls, the existing refusal is shown. Tested in Task 1.
- Quotes that all fail, such as 1Click down: agents are not called and the user sees a sentence. Tested in Task 1.
- 66-character Sui addresses reaching the rate limiter: the account is kept, not dropped. Tested in Task 1.
- Decimals of 6, 9, 18 and 24: the winner is the route with the better dollar output. Tested in Task 2.
- A second Review press on a NEAR, Avalanche or Monad route: no second deposit address while the first is on screen. Tested in Task 4.

---

### Task 1: Compete route takes a chain request

**Files:**

- Create: `apps/dapp/lib/agents/chain-routes.ts`
- Modify: `apps/dapp/app/api/agents/compete/route.ts`
- Modify: `apps/dapp/lib/chains/types.ts`
- Test: `apps/dapp/lib/__tests__/agents-chain-compete.test.ts`

**Interfaces:**

- Produces: `interface ChainRouteQuote { kind: 'chain'; request: ChainActionRequest; venueId: string; venueName: string; pay: { amount: string; symbol: string }; receive?: { amount: string; symbol: string }; apyPercent?: number; valueInUsd?: number; valueOutUsd?: number }`
- Produces: `quoteChainRoutes(chainApi: ChainModule, request: ChainActionRequest, account: string): Promise<QuotedRoute[]>`, with ids `${venueId}-1`, calling each usable venue's new optional `ChainVenue.quote`.
- Produces: `ChainVenue.quote?: (request: ChainActionRequest, account: string) => Promise<VenueQuote>` and `VenueQuote = { receive?: { amount: string; symbol: string }; apyPercent?: number; valueOutUsd?: number }`.
- Produces: compete body field `chainAction?: ChainActionRequest`.

- [ ] **Step 1: Write failing tests**, with `chainModule` mocked: `chain: 'near'` with `chainAction` streams `competition:started`, not `chain_unsupported`; a body without `chainAction` on `near` gets `chain_unsupported`; a Stellar body takes the old path; an unknown token ends in `competition:error` with no `brain.propose` call; all quotes failing ends in `competition:error` with no `brain.propose` call; `account` of 66 characters reaches `enforceRateLimit`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/agents-chain-compete.test.ts` from `apps/dapp`. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace `EXECUTING_CHAINS` with a check that `chain === 'stellar' || chainModule(chain) !== undefined`. Raise the account limit to 128. Add a branch after the roster check that builds `market.routes` from `quoteChainRoutes`, skips `parseIntent`, `resolveAsset`, `fetchOrderBookTop` and `ensureLiveAssets`, and builds a minimal `ParsedIntent` via a new `intentFromChainAction()` so `brain.propose` and logging keep their types.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): let the agent race take a chain action`.

### Task 2: Prompts and scoring tell the truth per chain

**Files:**

- Modify: `apps/dapp/lib/agents/brief.ts`, `apps/dapp/lib/agents/brains/openai-compatible.ts:309,354,366`, `apps/dapp/lib/agents/market-context.ts:145,208`, `apps/dapp/lib/agents/measure.ts`
- Modify: `apps/dapp/app/api/agents/compete/route.ts` (`measured`, `settlePlan`)
- Test: `apps/dapp/lib/__tests__/agents-chain-prompt.test.ts`

**Interfaces:**

- Consumes: `ChainRouteQuote` (Task 1).
- Produces: `systemPromptFor(chain: string): string`; `measureChainRoute(q: ChainRouteQuote): { outUsd: number; vsInPct: number } | undefined`; `settleChainPlan(p: AgentProposalResult): AgentProposalResult`.

- [ ] **Step 1: Write failing tests:** the prompt for `near` contains neither "testnet", "anchor", "rest" nor "split"; for `stellar` it equals today's `SYSTEM_PROMPT`; `measureChainRoute` ranks $4.97 out above $4.74 out from quotes in 6, 9, 18 and 24 decimals; a proposal with `executionMode: 'rest'` and `thenAction: 'lend'` becomes `fill` and `none`; `buildMarketContext('solana')` offers only venues with `integration: 'executes'`, and no Stellar tokens.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/agents-chain-prompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Supply and stake routes rank on `apyPercent`, using each venue's existing rate reader (`jupiter-lend.ts:140`, `kamino.ts:109`, `near/stake.ts:53`). Prices come from `chainApi.priceUsd`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): give agents each chain's own facts`.

### Task 3: NEAR races (hackathon, ships first)

**Files:**

- Modify: `apps/dapp/lib/chains/near/swap.ts`, `apps/dapp/lib/chains/near/stake.ts`, `apps/dapp/lib/chains/near/earn.ts`
- Test: `apps/dapp/lib/__tests__/near-race-quote.test.ts`

**Interfaces:**

- Consumes: `ChainVenue.quote` (Task 1).
- Produces: `quote` on `oneClickVenue`, `metapoolVenue`, `rnearVenue`, `earnVenue`.

- [ ] **Step 1: Write failing tests:** `oneClickVenue.quote` posts `dry: true` and returns `receive` and `valueOutUsd`; it runs `assertQuoteMatches`, reusing that check; it never reads `depositAddress`; each stake venue returns its `apyPercent`.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/near-race-quote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by reusing `requestQuote` and the preview half of `prepareOneClickDeposit`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): quote near venues for the agent race`.

### Task 4: The chat runs the race and Review signs the winner

**Files:**

- Modify: `apps/dapp/hooks/use-competition.ts`, `apps/dapp/components/intents/intent-chat.tsx` (the `parseChainAction` branch, `handleExecute`, `locked`), `apps/dapp/components/intents/competition-panel.tsx`, `apps/dapp/lib/orchestrate/capabilities.ts:11`
- Create: `apps/dapp/lib/agents/chain-race.ts`
- Test: `apps/dapp/lib/__tests__/agents-chain-race.test.ts`

**Interfaces:**

- Consumes: compete `chainAction` (Task 1), `ChainRouteQuote` (Task 1).
- Produces: `chainRequestFor(route: unknown, asked: ChainActionRequest): ChainActionRequest | undefined`, which returns the request with `venue` set and refuses anything whose token or amount differs from `asked`.
- Produces: `useCompetition` option `chainAction`, sent in place of `parsed`.

- [ ] **Step 1: Write failing tests:** `chainRequestFor` sets `venue`; it returns undefined when a route's amount, `tokenIn` or `tokenOut` differs from `asked`; it returns undefined for a Stellar `SwapQuote`; `singleRouteNote(1, 'NEAR')` returns the Global Constraints sentence; `singleRouteNote(2, 'NEAR')` returns undefined; a second call while one prepare is pending does not call `prepare` again.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/agents-chain-race.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the chat, `parseChainAction` success starts the race rather than `chainAction.prepare`. `handleExecute` on non-Stellar calls `chainAction.prepare(chainRequestFor(route, asked), text)`. If the race ends in an error frame, call `chainAction.prepare(asked, text)` so the chain keeps working when agents are offline. Include `chainAction.phase` signing and submitting in `locked`.
- [ ] **Step 4: Run** the same command and `pnpm exec tsc --noEmit`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(dapp): run the agent race on near from chat`.

### Task 5: Solana and Sui race, with 1Click as a second route

**Files:**

- Create: `apps/dapp/lib/chains/oneclick-origin.ts`
- Modify: `apps/dapp/lib/chains/near/oneclick.ts` (`assetIdOf` by chain), `apps/dapp/lib/chains/solana/jupiter-swap.ts`, `solana/jupiter-lend.ts`, `solana/kamino.ts`, `solana/lulo.ts`, `solana/module.ts`, `sui/cetus.ts`, `sui/navi.ts`, `sui/springsui.ts`, `sui/module.ts`
- Test: `apps/dapp/lib/__tests__/oneclick-origin.test.ts`, `apps/dapp/lib/__tests__/solana-sui-race-quote.test.ts`

**Interfaces:**

- Consumes: `solanaDeposit` and `suiDeposit` builders and asserters in `lib/weave/deposit/`.
- Produces: `oneClickOriginVenue(chain: 'solana' | 'sui' | 'avalanche' | 'monad'): ChainVenue`, whose `prepare` takes a `dry: false` quote and builds one transfer to its deposit address, whose `assertSafe` admits only that transfer, and whose `submit` confirms it and follows `depositStatus`.
- Produces: `oneClickAssetId(chain, token): Promise<string | undefined>` from `listTokens()`, matched on chain and contract, refusing a symbol match alone.

- [ ] **Step 1: Write failing tests:** the Jupiter `quote` uses `/swap/v2/order` and returns `receive` without exposing `transaction`; the Cetus `quote` returns its best route; `oneClickAssetId` refuses a look-alike symbol on another contract; `assertSafe` refuses a wrong recipient, wrong amount and an extra transfer; a deposit memo is refused; a native SOL or SUI input is refused with a plain sentence, so only USDC and USDT reach 1Click in this task.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/oneclick-origin.test.ts lib/__tests__/solana-sui-race-quote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generalise the deposit builders by passing the token rather than assuming USDC, keeping their tests green. Add the venue to `venues` in `solana/module.ts` and `sui/module.ts`. Add its row and logo per `feedback-always-add-venue-logos`, which `venue-logos.test.ts` enforces.
- [ ] **Step 4: Run** the same command plus `pnpm exec vitest run lib/__tests__/weave-deposit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): race jupiter and cetus against 1click`.

### Task 6: Avalanche and Monad can swap, and race

**Files:**

- Create: `apps/dapp/lib/chains/evm/module.ts`, `apps/dapp/lib/chains/evm/tokens.ts`, `apps/dapp/lib/chains/evm/submit.ts`
- Modify: `apps/dapp/lib/chains/types.ts` (`ChainWithActions`, evm `value`), `apps/dapp/lib/chains/registry.ts`, `apps/dapp/lib/chains/capabilities.ts`, `apps/dapp/lib/adapters/evm-adapter.ts` (Monad `signPrepared`, non-zero `value`), `apps/dapp/app/api/chain/[chain]/submit/route.ts` (`evm` in the union, family check), `apps/dapp/lib/__tests__/weave-deposit-avalanche.test.ts:512`
- Test: `apps/dapp/lib/__tests__/evm-module.test.ts`

**Interfaces:**

- Consumes: `oneClickOriginVenue` (Task 5).
- Produces: `avalancheModule`, `monadModule: ChainModule`, with tokens AVAX, USDC, USDT on Avalanche and MON, USDC, USDT0 on Monad, contract addresses read from 1Click's list and checked against `0xb97ef9ef8734...` for Avalanche USDC and `0x754704bc059f...` for Monad USDC.

- [ ] **Step 1: Write failing tests:** `chainModule('monad')` and `chainModule('avalanche')` are defined; a native AVAX transfer payload passes `assertSafe` only with `value` equal to the quote's amount and empty `data`; an ERC-20 payload passes only with `value: '0'`; a Monad `chainId` of 143 is required, and 43114 is refused on Monad; the submit route accepts `{ family: 'evm', hash }` for both; a receipt from another account is refused.
- [ ] **Step 2: Run** `pnpm exec vitest run lib/__tests__/evm-module.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Confirm Monad's chain id with `viem/chains` before writing it. Reuse the Avalanche deposit's receipt check for ERC-20 and write the equivalent for native.
- [ ] **Step 4: Run** `pnpm exec vitest run lib/__tests__/evm-module.test.ts lib/__tests__/weave-deposit-avalanche.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): swap and race on avalanche and monad through 1click`.

### Task 7: Record which chain each race ran on

**Files:**

- Modify: `apps/dapp/lib/server/analytics.ts:65`, `apps/dapp/app/api/agents/history/route.ts`, `apps/dapp/app/api/chain/[chain]/submit/route.ts:73-80`
- Create: `packages/db/migrations/014_agent_races_chain.sql`
- Test: extend `apps/dapp/lib/__tests__/agents-chain-compete.test.ts`

- [ ] **Step 1: Write failing tests:** `logRace` writes `chain`; the history route accepts a Solana, Sui, NEAR and EVM account rather than only `StrKey`; a chain submit carries the race id it came from.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement,** with `ALTER TABLE agent_races ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'stellar'` in both the migration and the code's DDL.
- [ ] **Step 4: Verify the whole change.** Run `pnpm exec tsc --noEmit`, `pnpm exec next lint --quiet` and `pnpm exec vitest run --maxWorkers=4 --minWorkers=1`. Expected: exit 0 for the first two. The only failures allowed are live-network tests in code this plan doesn't touch, and each must be named in the report.
- [ ] **Step 5: Commit** `feat(dapp): record the chain of every agent race`.

## Not in this plan

- Agents choosing limit orders, swap-then-deposit, or cash-out on these chains. They need those features to exist first.
- A second swap venue on NEAR (Rhea needs `ft_transfer_call`, which `near/safety.ts:10` refuses), Avalanche or Monad (neither is covered by the integration report), so these three start with one swap route.
- Native SOL and SUI through 1Click. Jupiter and Cetus still take them.
- A real signed transaction: the user does that with a funded wallet. No agent in this plan may sign or send.
