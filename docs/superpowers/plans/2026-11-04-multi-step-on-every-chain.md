# Multi-Step Transactions on Every Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Solana, Sui, NEAR, Avalanche and Monad, a person can do what Stellar already does in one conversation: see everything their wallet holds, keep their chat, and run a swap followed by a cash-out, deposit, stake or send.

**Architecture:** Stellar's `use-sequence.ts` is built on XDR, Horizon and anchors, so it is copied in behaviour, not reused. A new `useChainSequence` hook sits beside the existing `useChainAction` and `useCashout`: the race and signing for step 1 are unchanged, then the hook measures what actually arrived and hands that amount to step 2, which the person starts themselves. Balances gain a `ChainModule.balances` read behind one route. The chat stays mounted across pages by moving `IntentChat` into the chain layout, and a read-only transcript survives reloads.

**Tech Stack:** Next 15, React 19, TypeScript, viem, vitest (node, no DOM). pnpm monorepo, app in `apps/dapp`.

**Spec:** No design document: the person chose to skip it and said "build". What they asked for, from testing the preview on Solana:

- "the AI can only read solana wallet balance and not all the tokens"
- "first swap the sol to usdc then from usdc to fiat ... on all the chains not just stellar"
- "except the chat session ends or user starts new chat the chat should always persists"
- "Add each of the currency country logo"
- "multilayered txns of swap first then offramp then to other thing, for all the chain"

## Facts this plan rests on

Checked live on 2026-11-04.

- 1Click dry quotes to USDC work for SOL, AVAX and NEAR. **Every Monad-origin quote answers HTTP 400 "Internal server error"**, including ones that passed earlier the same day.
- Solana listing: `solana-rpc.publicnode.com` refuses `getTokenAccountsByOwner` (403). `api.mainnet-beta.solana.com` answered for both token programs, from a home connection. Its limits from Vercel are untested, and `SOLANA_RPC_URL` is unset on Preview and Production.
- Sui: `graphql.mainnet.sui.io` answers `address.balances`.
- NEAR: `https://api.fastnear.com/v1/account/{id}/ft` lists every fungible token held, with raw balances.
- EVM has no "all tokens" RPC, so Avalanche and Monad read known tokens only.
- A Weave order sets `walletAddress` and `refundAddress` to the paying wallet on the deposit chain (`lib/weave/client.ts:312-335`). Paying from another chain would leave no valid refund address, so cross-chain cash-out is out of this plan.
- Weave charges about 1% over the order amount. `lib/weave` accepts up to 2% over.
- Weave on NEAR fails at the order step (`Incorrect depositMode`). Weave does not list Monad.
- Weave institutions: UGX has two mobile money providers and no banks; KES and TZS have a mix; NGN has banks only.

## Global Constraints

- Stellar's behaviour does not change. Any Stellar regression is a defect, including its chat path, `use-sequence.ts` and its naira form.
- Never edit `components/intents/naira-payout-card.tsx`, `components/intents/bank-picker.tsx` or `hooks/use-naira-payout.ts`. The cash-out form's layout stays as prod's.
- An answer may lack `pending` only if it proves nothing moved. A step 1 that is `pending` or unknown never advances to step 2.
- Nothing opens a wallet on its own. Step 2 starts only from a press by the person.
- Step 2's amount is always measured from the chain, never taken from a quote, and never guessed when a read fails.
- A follow-on that cannot run is refused before step 1 is signed.
- No agent signs or sends. Dry quotes only in tests. No Weave order is created by any test or agent.
- Agents pick route ids only. Nothing an LLM writes affects what is signed.
- Client bundles import no server-only module or secret.
- No module reads the Stellar network at import. Every task's focused run includes `import-purity` and `routes-load-with-two-networks`.
- User-facing copy is true on every path it can appear on, plain, with no em dashes.
- Every integrated app ships its real logo in the same change. Country flags are local files, not a CDN.
- Commits: lowercase subject, header at most 100, body lines at most 100, no co-author line, no attribution footer. Stage named files only; never `.claude/`, `apps/dapp/.next-verify/` or `.env.local`.
- No dev server: port 3001 is the person's. No `next build` on Windows. Do not switch branches.
- vitest is node with no DOM and no BigInt literals, so logic goes in pure helpers under `lib/`.
- Vitest flags: always `--maxWorkers=4 --minWorkers=1` or lower, never `--maxWorkers=1` alone.

## Review Focus

1. Spending a wallet's whole native balance ("offramp 0.01477 SOL" with 0.01477 SOL held): refused before signing, naming what can be spent. Test in Task 4.
2. Step 1 answers pending, or the wallet reports an error after sending: step 2 is never offered, and the person is told to check before doing anything. Test in Task 5.
3. Measuring what arrived fails or stays at zero: the person is told they hold the token and nothing was paid out, with no amount guessed. Test in Task 5.
4. A different wallet connects between step 1 and step 2: step 2 refuses with the existing wrong-wallet sentence. Test in Task 5.
5. A transcript restored after a reload holds nothing signable, and another wallet never sees it. Test in Task 3.

---

### Task 1: Country logos and "mobile money" wording

**Files:**

- Create: `apps/dapp/public/flags/ng.svg`, `ke.svg`, `ug.svg`, `tz.svg`, `apps/dapp/lib/weave/currency-flag.ts`, `apps/dapp/lib/__tests__/currency-flag.test.ts`
- Modify: `apps/dapp/components/intents/cashout-currency-question.tsx`, `apps/dapp/components/intents/cashout-card.tsx`

**Interfaces:**

- Produces: `currencyFlag(code: string): { src: string; country: string } | undefined`, `payoutWord(types: readonly string[]): 'bank' | 'mobile money provider' | 'bank or mobile money'`.

- [ ] **Step 1: Write failing tests.** Each of NGN, KES, UGX and TZS returns `/flags/{ng,ke,ug,tz}.svg` and its country name, and the file exists under `public/flags`. An unknown code returns undefined. `payoutWord(['mobile_money','mobile_money'])` is `'mobile money provider'`, `['bank']` is `'bank'`, `['bank','mobile_money']` is `'bank or mobile money'`.
- [ ] **Step 2: Run** `pnpm exec vitest run currency-flag`. Expected: FAIL.
- [ ] **Step 3: Implement.** Take the four flags from the MIT-licensed `flag-icons` package's 4x3 SVGs, and copy the files in rather than adding a dependency. Show the flag before the name on each currency button and in the cash-out form's currency display. Where `cashout-card.tsx` itself writes "bank" for a non-naira currency, use `payoutWord` on the loaded institutions. If a sentence is hard-coded inside `bank-picker.tsx`, leave it and report it.
- [ ] **Step 4: Run** the test file, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): show each payout currency's country flag`.

### Task 2: Every token the wallet holds, read fresh

**Files:**

- Create: `apps/dapp/lib/chains/balance-reply.ts`, `apps/dapp/app/api/chain/[chain]/balances/route.ts`, `apps/dapp/lib/chains/solana/balances.ts`, `apps/dapp/lib/chains/sui/balances.ts`, `apps/dapp/lib/chains/near/balances.ts`, `apps/dapp/lib/chains/evm/balances.ts`, `apps/dapp/lib/__tests__/chain-balances.test.ts`
- Modify: `apps/dapp/lib/chains/types.ts`, each chain's `module.ts`, `apps/dapp/components/intents/intent-chat.tsx:1650-1654` and its call site

**Interfaces:**

- Produces in `lib/chains/types.ts`:

```ts
export interface TokenBalance {
  symbol: string
  id: string
  amount: string
  decimals: number
  native: boolean
  /** In this chain's token table. An unlisted token can't be traded here yet. */
  listed: boolean
}
export interface WalletBalances {
  tokens: TokenBalance[]
  /** False when only known tokens could be read. */
  complete: boolean
}
// ChainModule gains:
balances: (account: string) => Promise<WalletBalances>
```

- Produces: `GET /api/chain/[chain]/balances?account=` answering `WalletBalances`, or 503 `{ error }`. Rate limited with `enforceRateLimit(request, 'build')`. A malformed account answers 400.
- Produces: `chainBalanceReply(balances: WalletBalances | undefined, chainName: string): string`.

- [ ] **Step 1: Write failing tests**, with fetch stubbed to real response shapes:
  - Solana parses `getTokenAccountsByOwner` from both token programs plus `getBalance`, all with commitment `confirmed`. When listing is refused, it falls back to the token table with `complete: false`.
  - Sui parses `address.balances`, and an unlisted coin's symbol is the coin type's last segment.
  - NEAR parses the FastNEAR list, with a registry fallback and `complete: false` when it fails.
  - EVM reads native plus each table token, always `complete: false`, and Avalanche never reads Monad's table.
  - `chainBalanceReply`: native first, then listed, then unlisted with the shortened id (`AbCd…wXyZ`); zero balances dropped except native; over 30 tokens ends "and N more"; `complete: false` adds "Only tokens Intent knows on {chain} are shown."; `undefined` answers "I could not read your balance just now, so I won't guess. Try again in a moment." and no number.
- [ ] **Step 2: Run** `pnpm exec vitest run chain-balances`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Solana uses `SOLANA_RPC_URL`, else `https://api.mainnet-beta.solana.com`, on the server; never publicnode for listing.
  - Sui takes decimals from GraphQL `coinMetadata`, and an unknown one leaves the token out rather than guessing.
  - NEAR uses `https://api.fastnear.com/v1/account/{id}/ft`, with `ft_metadata` for at most 20 unlisted tokens.
  - In the chat, the non-Stellar branch of `walletBalanceReply` becomes async and fetches this route at the moment of asking. Stellar's branch is untouched.
- [ ] **Step 4: Run** the test file, `import-purity`, `routes-load-with-two-networks`, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): read every token a wallet holds on each chain`.

### Task 3: The chat stays until New chat

**Files:**

- Create: `apps/dapp/components/intents/chat-host.tsx`, `apps/dapp/lib/chat/live-session.ts`, `apps/dapp/lib/__tests__/live-session.test.ts`
- Modify: `apps/dapp/app/[chain]/layout.tsx`, `apps/dapp/app/[chain]/intents/page.tsx`, `apps/dapp/app/[chain]/intents/new/page.tsx`, `apps/dapp/components/intents/intent-chat.tsx`

**Interfaces:**

- Produces in `lib/chat/live-session.ts`:

```ts
export interface LiveTurn {
  role: 'user' | 'agent'
  text: string
  explorerUrl?: string
  at: number
}
export function liveSessionKey(chain: string, account: string): string
export function loadLiveSession(
  storage: Pick<Storage, 'getItem'> | undefined,
  chain: string,
  account: string
): LiveTurn[]
export function appendLiveTurn(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  chain: string,
  account: string,
  turn: LiveTurn
): void
export function clearLiveSession(
  storage: Pick<Storage, 'removeItem'> | undefined,
  chain: string,
  account: string
): void
```

- [ ] **Step 1: Write failing tests.** Two accounts or two chains never read each other's turns. The list caps at the newest 200. Broken storage or malformed JSON returns `[]` and never throws. Only `role`, `text`, `explorerUrl` and `at` are kept, with any other field dropped on load, so a saved entry cannot carry a signing payload, a route or a deposit address. `explorerUrl` must be `https:`, or it is dropped.
- [ ] **Step 2: Run** `pnpm exec vitest run live-session`. Expected: FAIL.
- [ ] **Step 3: Implement the mounted chat.** `ChatHost` is a client component in `app/[chain]/layout.tsx`, inside `ChainProvider`, keyed by chain. It renders the page header and `IntentChat` once a chain is open, and uses the `hidden` attribute when `usePathname()` is not `/{chain}/intents` or `/{chain}/intents/new`. The two page files stop rendering `IntentChat` and render nothing of their own beyond what they need. Keep whatever `intents/new` passes to the chat today. Because hooks stay mounted, a live race, card, latch and cash-out poll all survive navigation.
- [ ] **Step 4: Implement the transcript.** The chat appends each message it shows from the person and each agent reply, chain race outcome sentence, and settled hash. On mount with no live thread, it shows `loadLiveSession` for the connected account above the composer as plain read-only bubbles, with no buttons. `newChat()` calls `clearLiveSession`. Wallet disconnect hides it and doesn't delete it. A chain race settles to one sentence naming venue and result. Do not add chain races to `saveTurn`.
- [ ] **Step 5: Run** the test file, `import-purity`, `routes-load-with-two-networks`, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 6: Commit** `feat(dapp): keep the chat until a new chat starts`.

### Task 4: Reading a multi-step request, and refusing what can't finish

**Files:**

- Create: `apps/dapp/lib/chains/sequence.ts`, `apps/dapp/lib/chains/parse-sequence.ts`, `apps/dapp/lib/__tests__/chain-sequence.test.ts`
- Modify: `apps/dapp/lib/weave/parse-cashout.ts`, `apps/dapp/lib/weave/cashout-view.ts`, `apps/dapp/lib/chains/prepare.ts`, `apps/dapp/app/api/agents/compete/route.ts`

**Interfaces:**

- Produces in `lib/chains/sequence.ts`:

```ts
export type FollowOn =
  | { kind: 'cashout'; currency?: CashoutCurrencyCode }
  | { kind: 'supply' | 'stake'; venue?: string }
  | { kind: 'send'; recipient: string }
export interface ChainSequenceRequest {
  swap: ChainActionRequest
  followOn: FollowOn
}
export const SEQUENCE_CASHOUT_CHAINS: readonly ChainWithActions[] // solana, sui, avalanche
export function deliveredAmount(
  before: string | undefined,
  after: string | undefined,
  decimals: number
): string | undefined
export function cashoutAmountFrom(delivered: string): string
export function followOnRefusal(
  chain: ChainWithActions,
  chainName: string,
  followOn: FollowOn,
  venues: readonly Pick<ChainVenue, 'kinds'>[]
): string | undefined
export function strandedReply(symbol: string, amount: string | undefined): string
```

- Produces: `parseChainSequence(text: string): ChainSequenceRequest | { refusal: string } | null`.
- Produces in `lib/chains/prepare.ts`: `NATIVE_FEE_RESERVE: Record<ChainWithActions, string>` with `solana '0.005'`, `sui '0.05'`, `near '0.05'`, `avalanche '0.01'`, `monad '0.05'`, and `assertNativeReserve(chainApi: ChainModule, request: ChainActionRequest, account: string): Promise<void>`.
- `CashoutRead`'s `unsupportedToken` form gains `amount?: string`. `CashoutRoute` gains `{ kind: 'sequence'; token: string; amount: string; currency?: CashoutCurrencyCode }`.

- [ ] **Step 1: Write failing tests:**
  - `parseChainSequence` reads each of these into the right swap and follow-on: "swap 5 SOL to USDC then cash out", "swap 5 SOL to USDC and cash out to kes", "swap 5 SOL to USDC then deposit", "swap 5 SOL to USDC then stake", "swap 5 SOL to USDC then send to {address}".
  - "swap 5 SOL to BONK then cash out" gives `{ refusal }` saying cash-outs take USDC. "swap 5 SOL to USDC" returns null, since it is a plain swap. A plain deposit returns null.
  - `routeCashout({ unsupportedToken: 'SOL', amount: '0.5' }, 'solana')` gives `kind: 'sequence'`. The same on `stellar` still gives `pass`. With no amount it stays `token`. On `near` it stays `token`, and `unsupportedTokenReply` says there what is true on NEAR. Monad stays `pass`.
  - `deliveredAmount('1.5','6.5',6)` is `'5'`. Undefined on either side, or `after <= before`, gives undefined. It uses BigInt on base units, so `0.1 + 0.2` errors can't occur.
  - `cashoutAmountFrom('5')` is `'4.9'` and `cashoutAmountFrom('5.05')` is `'4.95'`: `floor(delivered / 1.02)` to 2 places on integers.
  - `followOnRefusal`: cash-out on `near` names Weave's NEAR deposits being unavailable; on `monad` says cash-outs don't run there; `supply` with no venue offering it names the chain; `send` with a venue offering it answers undefined; every refusal ends "Nothing was signed or sent."
  - `strandedReply('USDC','5')` includes "you are holding" and "nothing was paid out"; with undefined it includes no number.
  - `assertNativeReserve`: wallet holds 0.01477 SOL and asks 0.01477 refuses "Keep about 0.005 SOL for network fees. You can spend up to 0.00977 SOL here. Nothing was signed or sent."; asks 0.009 passes; a token other than native passes with no read; a failed balance read passes, because it must not block a trade.
- [ ] **Step 2: Run** `pnpm exec vitest run chain-sequence`. Expected: FAIL.
- [ ] **Step 3: Implement.** Call `assertNativeReserve` in both `prepareChainAction` and `chainRaceFacts`, so a doomed amount is refused before the agents run. Chat wiring is Task 5.
- [ ] **Step 4: Run** the test file, the `parse-cashout` tests, `import-purity`, `routes-load-with-two-networks`, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): read a swap and what comes after it`.

### Task 5: Swap then cash out

**Files:**

- Create: `apps/dapp/hooks/use-chain-sequence.ts`, `apps/dapp/lib/chains/sequence-flow.ts`, `apps/dapp/components/intents/chain-sequence-steps.tsx`, `apps/dapp/lib/__tests__/chain-sequence-flow.test.ts`
- Modify: `apps/dapp/components/intents/intent-chat.tsx`, `apps/dapp/components/intents/cashout-currency-question.tsx`

**Interfaces:**

- Consumes: Task 4's types, Task 2's route, `useChainAction`, `useCashout.open`.
- Produces in `lib/chains/sequence-flow.ts`:

```ts
export type SequenceStage = 'swap' | 'measuring' | 'ready' | 'next' | 'stranded' | 'done'
export function stageAfterSwap(phase: ChainActionPhase): SequenceStage | undefined
export function stageAfterMeasure(
  delivered: string | undefined,
  attempts: number,
  maxAttempts: number
): SequenceStage | 'keep'
export const MEASURE_INTERVAL_MS = 3_000
export const MEASURE_ATTEMPTS = 20
```

- Produces in the hook: `useChainSequence(chainAction, cashout)` returning `{ sequence, stage, delivered, error, start(request, text), runNext(), clear() }`.

- [ ] **Step 1: Write failing tests:**
  - `stageAfterSwap('settled')` is `'measuring'`.
  - `pending` and `failed` are `'stranded'`, and the signing, submitting, review and building phases are undefined. `pending` never reaches `'ready'` on any path.
  - `stageAfterMeasure('5', 1, 20)` is `'ready'`. Undefined before the limit is `'keep'`, and at the limit is `'stranded'`.
- [ ] **Step 2: Run** `pnpm exec vitest run chain-sequence-flow`. Expected: FAIL.
- [ ] **Step 3: Implement the hook.**
  - `start` reads the output token's balance from the balances route when step 1's card reaches `review`, and if that read fails, marks `before` as unknown.
  - On `settled`, it polls until the amount rises. An unknown `before` goes straight to stranded rather than guessing.
  - `runNext` for cash-out calls `cashout.open({ amount: cashoutAmountFrom(delivered), currency })`. It starts only from a press.
  - It compares the connected account with the one step 1 was signed by, using `accountMismatch`, and refuses with that sentence if they differ.
  - It adds no second latch: a new race is still what lifts `chainAction`'s latch.
- [ ] **Step 4: Wire the chat.**
  - In `startCashout`, `kind: 'sequence'` first checks `followOnRefusal`, then asks the currency with the existing question if none is named, then runs the race for `{ kind: 'swap', amount, tokenIn: token, tokenOut: 'USDC' }`.
  - `handleSubmit` tries `parseChainSequence` before `parseChainAction`.
  - `ChainSequenceSteps` shows "1 Swap 0.5 SOL to USDC" and "2 Cash out to {currency}" before anything is signed, the step in progress, and a "Cash out {amount} USDC" button at `ready`.
  - At `stranded`, it shows `strandedReply`. A pending step 1 shows the existing pending card, unchanged.
- [ ] **Step 5: Run** the test file, `agents-chain-race`, `import-purity`, `routes-load-with-two-networks`, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 6: Commit** `feat(dapp): swap then cash out on solana, sui and avalanche`.

### Task 6: Swap then deposit, stake or send, and plain send

**Files:**

- Create: `apps/dapp/lib/chains/send.ts`, `apps/dapp/lib/__tests__/chain-send.test.ts`
- Modify: `apps/dapp/lib/chains/types.ts`, `apps/dapp/lib/chains/parse-action.ts`, each chain's `module.ts`, `apps/dapp/hooks/use-chain-sequence.ts`, `apps/dapp/components/intents/chain-sequence-steps.tsx`, `apps/dapp/lib/agents/chain-routes.ts`

**Interfaces:**

- Consumes: the deposit builders in `lib/weave/deposit/*` and `lib/chains/evm/deposit.ts`, which already build and check one exact transfer. Reuse them; do not write a second transfer check.
- Produces: `ChainActionKind` gains `'send'`. `ChainActionRequest` gains `recipient?: string`. `createSendVenue(chain: ChainWithActions): ChainVenue` with id `send`, name `Wallet transfer`, kinds `['send']`, and no `quote`, so it never enters a race.

- [ ] **Step 1: Write failing tests:**
  - `parseChainAction('send 5 USDC to {address}')` gives kind `send` with the recipient unchanged in case.
  - On each chain, `prepare` builds exactly one transfer of that token and amount to that recipient, and `assertSafe` refuses another recipient, another amount, another token and trailing data.
  - A recipient that isn't valid on this chain is refused, including an EVM address on Solana and a Solana address on Sui.
  - A token contract as recipient is refused.
  - A NEAR recipient not registered with the token is refused with a plain sentence, since the transfer would fail.
  - Native SOL, SUI or NEAR that the builder can't move is refused plainly.
  - `assertWithinCap` applies.
  - A send never enters `quoteChainRoutes`, and a typed send goes straight to a review card with no race.
  - In the sequence: follow-on `supply`, `stake` or `send` prepares with `amount` equal to the measured delivery, and `tokenIn` equal to the swap's output.
- [ ] **Step 2: Run** `pnpm exec vitest run chain-send`. Expected: FAIL.
- [ ] **Step 3: Implement.** The review card shows the full recipient and the note "Transfers can't be undone. Check the address." Step 2's press calls `chainAction.release()` and then `prepare`, only from `stage === 'ready'`, so the latch is lifted once and only after step 1 is proven settled. Measured amounts over the token's decimals are floored.
- [ ] **Step 4: Run** the test file, `chain-sequence`, `import-purity`, `routes-load-with-two-networks`, `tsc`, then eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dapp): swap then deposit, stake or send on every chain`.

### Task 7: The chat understands all of it in ordinary words

**Files:**

- Modify: `apps/dapp/lib/orchestrate/capabilities.ts`, `apps/dapp/lib/chains/capabilities.ts`, `apps/dapp/components/intents/intent-chat.tsx`, `apps/dapp/lib/chains/parse-sequence.ts`
- Test: `apps/dapp/lib/__tests__/orchestrate-capabilities-chain.test.ts`, `apps/dapp/lib/__tests__/chain-sequence.test.ts`

**Interfaces:**

- Produces: `sequenceFromReading(reading: UnderstoodIntent): ChainSequenceRequest | null` in `lib/chains/parse-sequence.ts`.

- [ ] **Step 1: Write failing tests.**
  - A reading with a swap and an off-ramp, lend or send `followOn` converts to the matching sequence. One that has no `followOn` returns null.
  - `capabilitySheet` on Solana, Sui and Avalanche says swap then cash out runs. On NEAR it says swap then deposit and send run, and cash-out doesn't. On Monad it says swap and send run, and cash-out and deposit don't.
  - Limit orders remain listed as not available off Stellar.
  - `chainHelp` lists what works in the new forms.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement.** Off Stellar, where the orchestrator's reading has a `followOn`, the chat runs `sequenceFromReading` through the same path as Task 5, and never reaches the Stellar branches of `startIntent`. Drop `followOn` silently nowhere: a follow-on that can't convert is refused with `followOnRefusal`.
- [ ] **Step 4: Verify the whole change.** From `apps/dapp` run `pnpm exec tsc --noEmit`, `pnpm exec next lint --quiet` and `pnpm exec vitest run --maxWorkers=4 --minWorkers=1`. Expected: exit 0 for the first two. The only failures allowed are live-network tests in code this plan doesn't touch, each named in the report with its cause.
- [ ] **Step 5: Commit** `feat(dapp): read multi-step requests in ordinary words on every chain`.

## Not in this plan

- Limit orders off Stellar (Kamino, DeepBook, Rhea, CoW) and new apps get their own plans. Research is in the session's scratchpad.
- Cash-out from NEAR or Monad: NEAR needs Weave to fix `Incorrect depositMode`. Monad needs Weave support, or a bridge step that needs gas on another chain.
- Trading a token that isn't in the chain's token table. Balances show it and mark it unlisted; a swap of it is refused as today.
- More than one follow-on after a swap. Stellar also runs one.
- Fixing 1Click's Monad errors, which are upstream.
- A history screen for chain races.
- A real signed transaction: the person does that with a funded wallet.
