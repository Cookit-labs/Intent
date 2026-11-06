# Limit Orders Off Stellar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can place, watch, cancel and collect a limit order on Solana, Sui, NEAR and Avalanche, Monad refuses in words, and race agents can recommend resting an order instead of filling now.

**Architecture:** A limit order is a new `ChainActionKind`, `limit`, that goes through the existing prepare, assert, sign and submit path, one venue per chain. Orders live on the chain or in CoW's book and are read back, so there is no database. A `LimitBook` on the chain module reads orders and builds their exits (cancel, collect). The race gets a resting option beside its fill routes, and a rest proposal becomes a `limit` request when pressed.

**Tech Stack:** Next 15, `@solana/kit` 8, `@mysten/sui` 2.31.2, viem 2, wagmi 2, vitest.

**Spec:** the user's request, "build limit orders" after "the AI should be able to do bundled swaps, limit swaps and so on on all chain", and the venue research in `docs/research/2026-11-05-limit-orders/` (`solana.md`, `sui.md`, `near.md`, `evm.md`). Those reports hold the addresses, discriminators, account orders and move targets. Read the one for your task. Facts marked unverified there are not facts.

## Global Constraints

- **No new dependencies.** `pnpm install` is not available in this worktree, `limo-sdk` pins kit 8.3.0 and pulls in web3.js v1, and `deepbook-v3` needs a newer `@mysten/sui`. Build instructions by hand with what is installed. A package may be read from a tarball in the scratchpad (`npm pack`), never added.
- Work only in `.claude/worktrees/limit-orders`, branch `feat/chain-limit-orders`. Never run `pnpm install` here: `node_modules` are junctions into the main checkout. Never switch branches in the main checkout.
- Nothing is ever signed or sent. Live checks read and simulate only, in files named `*.live.test.ts`. Run a live test only by its exact file name. Every other test run excludes them with `--exclude '**/*.live.test.ts'`.
- Every focused run also includes `lib/__tests__/import-purity.test.ts` and `lib/__tests__/routes-load.test.ts`. Run from `apps/dapp` with `npx vitest run <files> --reporter=basic --maxWorkers=3 --minWorkers=1`.
- Stellar does not change. Its prompt stays pinned by hash, and `chainCapabilities('stellar')` stays undefined.
- Only the person's own words decide the amount, the tokens and a stated price. A race may propose a resting price only inside the band in Task 9, and the person presses Review and signs.
- A refusal says what happened and ends `Nothing was signed or sent.`
- Limit orders never cross the market on purpose: an order that would fill at once at a worse price than the market is refused, by `assertRestingPrice`.
- Every venue ships its real logo in the task that adds it. A test enforces this.
- Vitest has no DOM and no BigInt literals (`BigInt('10')`). Push logic into pure helpers under `lib/`.
- Commit subjects are lowercase and at most 100 characters, with body lines at most 100. No co-author lines or attribution. Stage files by name, never `.claude/` or `.next-verify/`.
- Don't touch `naira-payout-card.tsx`, `bank-picker.tsx` or `use-naira-payout.ts`.

## Review Focus

1. A typo in the price: "sell 1 SOL at 1.10" must be refused in words, not rest forever or fill at a loss. Pinned in Task 1.
2. The direction of a price: "swap 50 USDC to SOL at 90" spends 50 USDC for at least 0.5556 SOL, and rounding never gives less than the stated price. Pinned in Task 1.
3. An order that filled while its card was open: pressing Cancel on it must collect or say so, never fail silently or sign something useless. Pinned in Task 7.
4. Someone else's order: an exit for an order id the connected account doesn't own is refused on the server. Pinned in Tasks 2, 3, 4, 5, 6.
5. Too little native coin: an order that leaves too little to pay its cost and fees is refused before signing, and the cost is shown first. Pinned in Task 2.

---

## File map

| File                                               | Responsibility                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `lib/chains/limit.ts`                              | Pure price and amount maths, price sanity, `RestingOrder`, `LimitBook` |
| `lib/chains/parse-limit.ts`                        | Reads a limit order from typed words, and the words gate               |
| `app/api/chain/[chain]/orders/route.ts`            | Lists orders, builds an exit                                           |
| `lib/chains/solana/limo.ts`, `limo-rules.ts`       | Kamino venue, book and safety                                          |
| `lib/chains/sui/deepbook.ts`, `deepbook-rules.ts`  | DeepBook venue, book and policy                                        |
| `lib/chains/near/rhea-dcl.ts`, `rhea-dcl-rules.ts` | Rhea venue, book and safety                                            |
| `lib/chains/evm/cow.ts`, `cow-rules.ts`            | CoW venue, book and safety                                             |
| `components/intents/chain-orders-card.tsx`         | The list, with Cancel and Collect                                      |
| `lib/agents/rest-option.ts`                        | The resting option given to agents, and the band                       |

---

### Task 1: The maths and the words

**Files:**

- Create: `apps/dapp/lib/chains/limit.ts`, `apps/dapp/lib/chains/parse-limit.ts`
- Modify: `apps/dapp/lib/chains/types.ts` (`ChainActionKind` adds `'limit'`; `ChainActionRequest` adds `limitPrice?: string | undefined`), `apps/dapp/lib/chains/parse-action.ts` (`racesFirst` false for `limit`)
- Test: `apps/dapp/lib/__tests__/chain-limit.test.ts`

**Interfaces:**

- Produces, in `limit.ts`:
  - `limitPair(tokenIn: string, tokenOut: string): { base: string; quote: string; selling: boolean } | undefined`. Quote is the stablecoin side (USDC or USDT), and nothing for two stablecoins or no stablecoin.
  - `limitOutput(amountIn: string, price: string, selling: boolean, decimalsIn: number, decimalsOut: number): bigint`. Exact BigInt arithmetic. Selling: amount times price. Buying: amount divided by price. Always rounds up, so the order never accepts less than the stated price.
  - `assertRestingPrice(price: string, marketUsd: number, selling: boolean, symbol: string): void`, which throws `ChainActionRefused`.
  - `interface RestingOrder { id: string; venueId: string; tokenIn: string; tokenOut: string; amountIn: string; remainingIn: string; receivedOut: string; collectable?: { amount: string; symbol: string }[]; limitPrice?: string; status: 'open' | 'partly' | 'filled' | 'done'; expiresAt?: number; note?: string }`
  - `interface LimitBook { openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]>; prepareExit(account: string, orderId: string, action: 'cancel' | 'collect'): Promise<PreparedAction> }`
- Produces, in `parse-limit.ts`:
  - `parseChainLimit(text: string): ChainActionRequest | null`
  - `limitSaid(request: ChainActionRequest, turns: readonly string[]): boolean`
- Modifies: `ChainModule` adds `limitBook?: LimitBook`. `PreparedAction` adds `thenPrepareAgain?: true`, meaning this is a setup step and the same request must be prepared again once it settles.

- [ ] **Step 1: Write the failing tests**

```ts
describe('limitOutput', () => {
  it('sells at the stated price', () => {
    expect(limitOutput('1', '110', true, 9, 6)).toBe(BigInt('110000000'))
  })
  it('buys at the stated price, rounding so the price is never worse', () => {
    expect(limitOutput('50', '90', false, 6, 9)).toBe(BigInt('555555556'))
  })
  it('keeps precision a float would lose', () => {
    expect(limitOutput('0.1', '0.3', true, 9, 6)).toBe(BigInt('30000'))
  })
})

describe('limitPair', () => {
  it('reads the side from the token given up', () => {
    expect(limitPair('SOL', 'USDC')).toEqual({ base: 'SOL', quote: 'USDC', selling: true })
    expect(limitPair('USDC', 'SOL')).toEqual({ base: 'SOL', quote: 'USDC', selling: false })
  })
  it('has no pair without exactly one stablecoin', () => {
    expect(limitPair('SOL', 'JUP')).toBeUndefined()
    expect(limitPair('USDC', 'USDT')).toBeUndefined()
  })
})

describe('assertRestingPrice', () => {
  it('refuses a sale below the market, which would fill at once at a loss', () => {
    expect(() => assertRestingPrice('90', 100, true, 'SOL')).toThrow(/below/)
  })
  it('refuses a purchase above the market', () => {
    expect(() => assertRestingPrice('110', 100, false, 'SOL')).toThrow(/above/)
  })
  it.each([
    ['1.10', 100, true],
    ['1000', 100, true],
    ['1', 100, false],
  ])('refuses %s against a market of %s as a likely typo', (price, market, selling) => {
    expect(() => assertRestingPrice(price, market, selling, 'SOL')).toThrow(/Nothing was signed/)
  })
  it('takes a price on the right side, within half the market either way', () => {
    expect(() => assertRestingPrice('110', 100, true, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('149', 100, true, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('90', 100, false, 'SOL')).not.toThrow()
    expect(() => assertRestingPrice('51', 100, false, 'SOL')).not.toThrow()
  })
})

describe('parseChainLimit', () => {
  it.each([
    ['sell 1 SOL at $110', { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' }],
    [
      'sell 1 sol for usdt at 110',
      { amount: '1', tokenIn: 'sol', tokenOut: 'usdt', limitPrice: '110' },
    ],
    [
      'limit sell 1 SOL at 110',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' },
    ],
    [
      'swap 1 SOL to USDC at $110',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' },
    ],
    [
      'swap 1 SOL to USDC when it hits 110.50',
      { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110.50' },
    ],
    [
      'swap 50 USDC to SOL at 90',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    [
      'buy SOL with 50 USDC at $90',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    [
      'buy SOL at $90 with 50 USDC',
      { amount: '50', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' },
    ],
    ['sell 1 solana at 110', { amount: '1', tokenIn: 'SOL', tokenOut: 'USDC', limitPrice: '110' }],
  ])('reads %s', (typed, want) => {
    expect(parseChainLimit(typed)).toEqual({ kind: 'limit', venue: undefined, ...want })
  })

  it.each([
    'sell 1 SOL',
    'swap 1 SOL to USDC',
    'sell 1 SOL at 1,10',
    'sell $5 of SOL at 110',
    'buy 2 SOL at 90',
    'sell 1 SOL at 110 then cash out',
  ])('leaves %s alone', (typed) => {
    expect(parseChainLimit(typed)).toBeNull()
  })
})

describe('limitSaid', () => {
  const asked = {
    kind: 'limit' as const,
    amount: '1',
    tokenIn: 'SOL',
    tokenOut: 'USDC',
    limitPrice: '110',
  }
  it('wants the amount by its token and the price after it, in the persons own words', () => {
    expect(limitSaid(asked, ['sell 1 SOL at $110'])).toBe(true)
    expect(limitSaid(asked, ['sell 1 SOL', 'at 110'])).toBe(true)
  })
  it('refuses a figure they never said', () => {
    expect(limitSaid({ ...asked, limitPrice: '120' }, ['sell 1 SOL at $110'])).toBe(false)
    expect(limitSaid({ ...asked, amount: '2' }, ['sell 1 SOL at $110'])).toBe(false)
  })
  it('refuses price and amount swapped round', () => {
    expect(limitSaid({ ...asked, amount: '110', limitPrice: '1' }, ['sell 1 SOL at $110'])).toBe(
      false
    )
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run lib/__tests__/chain-limit.test.ts --reporter=basic`
Expected: FAIL, cannot load `../chains/limit`.

- [ ] **Step 3: Implement**

`assertRestingPrice` copy: selling below the market, `That would sell below today's ${symbol} price of about $${m}, so it would fill at once. Name a price above it. Nothing was signed or sent.`, and the mirror for buying above. More than 50% from the market either way: `$${price} is far from today's ${symbol} price of about $${m}. Check the figure and send it again. Nothing was signed or sent.` Decimal commas are refused, as in `AMOUNT`. `buy 2 SOL at 90` names the amount received, which no venue here can hold exactly, so it stays unread and goes to the model, which refuses it in Task 8.

- [ ] **Step 4: Run them to see them pass, with import-purity and routes-load**

- [ ] **Step 5: Commit**: `feat(dapp): read a limit order and do its price sums`

---

### Task 2: The routes and the checks every venue shares

**Files:**

- Create: `apps/dapp/app/api/chain/[chain]/orders/route.ts`
- Modify: `apps/dapp/lib/chains/prepare.ts`, `apps/dapp/lib/chains/capabilities.ts` (and each chain's `capabilities.ts`), `apps/dapp/app/api/chain/[chain]/prepare/route.ts`
- Test: `apps/dapp/lib/__tests__/chain-limit-routes.test.ts`

**Interfaces:**

- Consumes: Task 1.
- Produces: `GET /api/chain/[chain]/orders?account=` returns `{ orders: RestingOrder[] }`, 404 `unknown_chain`, 400 `invalid_account`, 503 `orders_unavailable`, and rate family `read`. `POST` with `{ account, orderId, action }` returns a prepared action as the prepare route does, with rate family `build` and the same wallet gate as the prepare route. 422 with `error` for a refusal.
- Produces: `assertLimitCanRun(chainApi: ChainModule, request: ChainActionRequest, account: string): Promise<void>` in `prepare.ts`, which `prepareChainAction` calls for `limit`.
- Produces: `LIMIT_NOT_HERE: Partial<Record<ChainWithActions, string>>`, with `monad: "Monad has no limit order venue I would trust with your money yet. The only real option, Kuru, keeps deposits in an upgradeable contract with no audit I could find. Nothing was signed or sent."`

- [ ] **Step 1: Write the failing tests**

Cover, with a mocked module (as `chain-price-route.test.ts` does):

- `prepareChainAction` for `limit` on `monad` throws the `LIMIT_NOT_HERE` copy.
- A `limit` request with a price that fails `assertRestingPrice` is refused before the venue's `prepare` runs, and the venue was not called.
- No live price: refused with `I have no live price for SOL, so I can't check that price. Nothing was signed or sent.`, venue not called.
- A pair with no stablecoin: `Limit orders here need USDC or USDT on one side. Nothing was signed or sent.`
- `assertNativeReserve` counts a venue's stated setup cost: a limit selling SOL with 0.0148 SOL held and a cost of 0.00684 SOL is refused, and the refusal names the cost.
- GET and POST status codes above. POST with an `action` other than `cancel` or `collect` is 400. A module with no `limitBook` answers `{ orders: [] }` on GET and 422 on POST.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** `ChainVenue` gains `limitCost?: { amount: string; symbol: string }`, added to the native reserve for that venue. `assertAmountWithinCap` runs on a limit order as on any other action. Off Stellar help text (`chainHelp`) names limit orders where a venue exists.
- [ ] **Step 4: Run them to see them pass, with import-purity and routes-load**
- [ ] **Step 5: Commit**: `feat(dapp): route limit orders and refuse them where no venue is safe`

---

### Task 3: Solana, Kamino

**Files:**

- Create: `apps/dapp/lib/chains/solana/limo.ts`, `apps/dapp/lib/chains/solana/limo-rules.ts`, `apps/dapp/lib/__tests__/solana-limo.test.ts`, `apps/dapp/lib/__tests__/solana-limo.live.test.ts`
- Modify: `apps/dapp/lib/chains/solana/venues.ts`, `module.ts`, `programs.ts`, `capabilities.ts`, `sign.ts` if needed

**Interfaces:**

- Consumes: Task 1 and 2. `decodeSolanaTransaction`, `associatedTokenAccount`, `ownWrappedSolAccount` from `assert-safe.ts`.
- Produces: venue id `kamino-limit`, name `Kamino Limit Orders`, kinds `['limit']`, `limitCost` `0.00684 SOL`. `limoBook(): LimitBook`.
- Pinned values: program `LiMoM9rMhrdYrfzUCxQppvxCSG1FcrUK9G8uLq4A1GF`, global config `prod7Mog8r56sn5dPwze8nVdf94veEawdxNNqd5v7A1`, instruction bytes and account order from `docs/research/2026-11-05-limit-orders/solana.md`. Pairs: SOL, USDC and USDT only.

- [ ] **Step 1: Write the failing tests**

- `buildCreate` for 1 SOL to USDC at 110 decodes to: `create_order` with input `1000000000`, output `110000000`, order type 0. Maker, ATAs and PDAs as the report says. An idempotent create of the output ATA is present, because the SDK omits it and fills can fail without it. Wrap, sync and close of wSOL are present.
- USDC to SOL has no output ATA create, and no wrap.
- `limoAssertSafe` passes that payload, and refuses each of: another global config, another maker, another vault, input or output amount changed by one, an extra system transfer to anyone, a close-account destination that isn't the maker, `update_order`, a second extra signer, and an order account the transaction doesn't create at exactly 424 bytes owned by the program.
- `prepare` reads the live config (mocked) and refuses when `txn_fee_cost + ata_creation_cost` is above `10_000_000` lamports, or `new_orders_blocked` is set. The cost is inside the program's call, so the signed bytes can't show it.
- `prepare` refuses a mint whose vault doesn't exist.
- `decodeOrder` on a real order account, captured to a fixture by the live test, reads remaining, filled output, status and maker.
- `prepareExit` refuses an order whose maker isn't the account, and a filled order offers `collect` (closes it for rent and tips) with the summary saying the SOL comes back.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** The order keypair is generated on the server with kit, signs the message, and is thrown away. Check that the wallet path keeps that signature: the transaction reaches the wallet partly signed, and `solanaAssertSafe` must accept exactly this one extra signer, which must be the account the transaction creates. `notes`: `This stays open until it fills or you cancel it. There is no expiry.`, `Costs about 0.003 SOL, probably not refunded, and locks 0.00384 SOL until you close the order.`, `Only Pyth Express Relay searchers fill it. It may never fill, and small orders are less likely to.`, `Kamino can upgrade this program, so your escrowed amount carries that risk.`
- [ ] **Step 4: Run `solana-limo.live.test.ts` by its exact name.** It reads the config and one real order for the fixture, simulates a create for a public funded wallet, and asserts `getProgramAccounts` filtered by maker answers on `api.mainnet-beta.solana.com`. If that read is refused, `openOrders` answers from a list of order addresses the browser stored at signing, and the note in chat names `SOLANA_RPC_URL`.
- [ ] **Step 5: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 6: Commit**: `feat(dapp): place, read and close kamino limit orders on solana`

---

### Task 4: Sui, DeepBook

**Files:**

- Create: `apps/dapp/lib/chains/sui/deepbook.ts`, `apps/dapp/lib/chains/sui/deepbook-rules.ts`, `apps/dapp/lib/__tests__/sui-deepbook.test.ts`, `apps/dapp/lib/__tests__/sui-deepbook.live.test.ts`
- Modify: `apps/dapp/lib/chains/sui/safety.ts`, `policies.ts`, `venues.ts`, `module.ts`, `capabilities.ts`, `apps/dapp/lib/chains/venue-logos` (or wherever the logo table lives), `apps/dapp/public/`

**Interfaces:**

- Produces: `ReadObject = (argument) => string | undefined`, passed to `PtbPolicy.checkCall` as a fourth argument. Existing policies ignore it. Venue id `deepbook-limit`, name `DeepBook`, kinds `['limit']`. `deepbookBook(): LimitBook`.
- Pinned values: package, pools and registry from `docs/research/2026-11-05-limit-orders/sui.md`. Pair: SUI/USDC only. Order type POST_ONLY, so it can never fill at once. Expiry now plus 7 days. Tick, lot and minimum read from the chain, never the indexer, which disagrees.

- [ ] **Step 1: Settle the three unknowns by simulation.** In `sui-deepbook.live.test.ts`, simulate, without signing, for a public funded wallet:
  1. `new`, `deposit`, `generate_proof_as_owner`, `place_limit_order`, then `public_share_object`, all in one transaction.
  2. `pay_with_deep = false` on POST_ONLY.
  3. `balance_manager::register_balance_manager`, reading its Move source first. Allow it only if it does nothing but record the owner's id in the registry.

  Record the outcomes at the top of `deepbook.ts`. If (1) fails, first use is two signatures: creating the manager returns `thenPrepareAgain`. If (2) fails, the order needs DEEP: `prepare` reads `get_order_deep_required`, and if the manager and wallet can't cover it, refuses with `DeepBook needs about ${n} DEEP in your wallet to place this. Nothing was signed or sent.` If (3) isn't safe, the browser stores the manager id per wallet, and a new device shows a new manager.

- [ ] **Step 2: Write the failing tests**

- Selling 2 SUI at 1.10 builds: deposit 2 SUI, place with `is_bid` false, price and quantity on tick and lot, POST_ONLY, expiry 7 days on, then share only if the manager is new.
- Buying with 11 USDC at 1.00 deposits 11 USDC and places a bid for 11 SUI.
- Below 1 SUI: `DeepBook's smallest SUI order is 1 SUI. Nothing was signed or sent.` A quantity off the lot rounds down, and the card shows the rounded figure.
- `DEEPBOOK_POLICY` passes those, and refuses each of: `mint_trade_cap`, `mint_deposit_cap`, `mint_withdraw_cap`, `new_with_custom_owner`, `set_owner`, another pool id with the right types, wrong type arguments, price or quantity changed, order type other than POST_ONLY, expiry past 8 days, `public_share_object` of anything but a `BalanceManager`, and a deposit coin that differs from the expected amount.
- An existing manager whose on-chain owner isn't the account is refused before building.
- `prepareExit` cancel builds `cancel_order` then `withdraw_all` for both coins in one transaction, with `TransferObjects` to the account only. `collect` builds `withdraw_all` for both. An order or manager that isn't the account's is refused.
- `openOrders` marks money waiting in the manager as `collectable`, and its summary never implies it is in the wallet.

- [ ] **Step 3: Run them to see them fail**
- [ ] **Step 4: Implement.** `notes`: `Filled or cancelled tokens stay in your DeepBook account until you press Collect, which needs a second signature.`, `Expires in 7 days. Anything unfilled then waits to be collected.`, `It never fills at once. If the price has already passed yours, placing it fails and nothing moves.`
- [ ] **Step 5: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 6: Commit**: `feat(dapp): place, read and collect deepbook limit orders on sui`

---

### Task 5: NEAR, Rhea

**Files:**

- Create: `apps/dapp/lib/chains/near/rhea-dcl.ts`, `apps/dapp/lib/chains/near/rhea-dcl-rules.ts`, `apps/dapp/lib/__tests__/near-rhea-dcl.test.ts`, `apps/dapp/lib/__tests__/near-rhea-dcl.live.test.ts`
- Modify: `apps/dapp/lib/chains/near/safety.ts` (header comment and a new export), `venues.ts`, `module.ts`, `capabilities.ts`, logo table and `apps/dapp/public/`

**Interfaces:**

- Produces: `assertDclOrderSafe(payload, account, expected)`, `assertDclExitSafe(payload, account, orderId)`, venue id `rhea-limit`, name `Rhea`, kinds `['limit']`, `rheaBook(): LimitBook`, and `pointForPrice(priceUsdcPerNear: number, selling: boolean, delta: number): number`.
- Pinned values: contract `dclv2.ref-labs.near`, pool `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100`, delta 1, USDC/wNEAR only. Storage capped at 0.5 NEAR.

- [ ] **Step 1: Write the failing tests**

```ts
describe('pointForPrice', () => {
  // USDC per NEAR = 1e18 / 1.0001^point, read from orders resting on this pool on 2026-11-05.
  it('sells NEAR at a point below the market, and no cheaper than asked', () => {
    const point = pointForPrice(4.29, true, 1)
    expect(Math.abs(point - 399922)).toBeLessThan(10)
    expect(1e18 / 1.0001 ** point).toBeGreaterThanOrEqual(4.29)
  })
  it('buys NEAR at a point above the market, and no dearer than asked', () => {
    const point = pointForPrice(0.909, false, 1)
    expect(Math.abs(point - 415439)).toBeLessThan(10)
    expect(1e18 / 1.0001 ** point).toBeLessThanOrEqual(0.909)
  })
  it('keeps to the pool step', () => {
    expect(pointForPrice(4.29, true, 40) % 40).toBe(0)
  })
})
```

Also:

- A sale at a point at or above the pool's `current_point`, or a purchase at or below it, is refused. `LimitOrderWithSwap` swaps a marketable part at once with no minimum out, so an order must never be marketable.
- First use builds, in order: storage on `dclv2` as its own transaction, buy-token storage if unregistered, then the token transaction. `near_deposit` first when selling native NEAR.
- `assertDclOrderSafe` passes that, and refuses: another contract, another pool, another `buy_token`, a changed amount or point, extra keys in `msg`, `client_id` other than `""`, deposit other than 1 yocto, gas above 250 TGas, storage above 0.5 NEAR. `ft_transfer_call` stays refused everywhere else: the existing `assertNearPayloadSafe` tests still pass unchanged.
- `prepareExit` cancel is `cancel_order` with the remaining amount. `collect` is `cancel_order` with `amount: "0"`. Both no deposit, 180 TGas at most. An `order_id` whose `get_order` owner isn't the account is refused.
- `openOrders` reads `list_active_orders` and marks `unclaimed_amount` as `collectable`.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** Proceeds of a NEAR purchase arrive as wNEAR, and a sale's proceeds as USDC. `notes`: `When it fills, press Collect to receive it. That needs a second signature.`, `First use sets aside up to 0.5 NEAR for storage on Rhea. I could not confirm it comes back.`, `A purchase pays out in wNEAR.`, `This stays open until it fills or you cancel it.`
- [ ] **Step 4: Run `near-rhea-dcl.live.test.ts` by its exact name.** It reads the pool and a real order, checks the point formula against them, and reads `get_user_storage_detail`.
- [ ] **Step 5: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 6: Commit**: `feat(dapp): place, read and collect rhea limit orders on near`

---

### Task 6: Avalanche, CoW, and signing a message

**Files:**

- Create: `apps/dapp/lib/chains/evm/cow.ts`, `apps/dapp/lib/chains/evm/cow-rules.ts`, `apps/dapp/lib/__tests__/evm-cow.test.ts`, `apps/dapp/lib/__tests__/evm-cow.live.test.ts`
- Modify: `apps/dapp/lib/chains/types.ts` (`SigningPayload` and `SignedPayload` add `evm-typed`), `apps/dapp/lib/adapters/evm-adapter.ts` (`signOn`), `apps/dapp/lib/chains/evm/venues.ts`, `module.ts`, `capabilities.ts`, logo table and `apps/dapp/public/`

**Interfaces:**

- Produces: `SigningPayload` variant `{ family: 'evm-typed'; chainId: number; account: string; typedData: { domain: object; types: object; primaryType: 'Order'; message: CowOrder } }`, `SignedPayload` variant `{ family: 'evm-typed'; signature: string }`. Venue id `cow-limit`, name `CoW Protocol`, kinds `['limit']`, on Avalanche only. `cowBook(): LimitBook`.
- Pinned values: settlement, relayer, WAVAX, USDC and the type fields from `docs/research/2026-11-05-limit-orders/evm.md`. `validTo` now plus 7 days, `feeAmount` `"0"`, both balances `erc20`, `partiallyFillable` true, kind `sell`, empty app data with no hooks, no partner fee.

- [ ] **Step 1: Write the failing tests**

- `prepare` walks by what the chain says: AVAX to sell and not enough WAVAX returns a `deposit()` on WAVAX with `thenPrepareAgain`. Too little allowance returns an exact `approve` to the relayer with `thenPrepareAgain`, never a max approval. Otherwise it returns the typed data.
- `cowAssertSafe` passes those, and refuses each of: another `verifyingContract`, chain id or domain name, another receiver or the zero address, a changed token or amount, `validTo` past 8 days or in the past, `feeAmount` not `"0"`, a balance other than `erc20`, non-empty app data, and an `approve` with another spender or a higher amount.
- `submit` recovers the signer with viem and refuses when it isn't the account, which also refuses smart-contract wallets in words. It posts the order, computes the UID locally, and refuses when the answer differs. It returns `{ ok: true, hash: uid, explorerUrl: 'https://explorer.cow.fi/avax/orders/' + uid }`.
- A CoW answer of `SellAmountDoesNotCoverFee` reads `That is too small for CoW's solvers to fill. Try a few dollars more. Nothing was signed or sent.`
- `signOn` refuses a typed payload for another chain or another account, and passes one to wagmi's `signTypedData`. The signing logic is a pure helper with tests, as the adapter has no DOM.
- `prepareExit` cancel returns `invalidateOrder` on settlement, an ordinary transaction with a gas cost, which is definitive where the off-chain cancel is best effort. An order owned by someone else is refused. There is no `collect`, as fills arrive in the wallet.
- `openOrders` maps CoW statuses to `RestingOrder`, and `executedBuyAmount` to `receivedOut`.

- [ ] **Step 2: Settle two unknowns live.** In `evm-cow.live.test.ts`, by exact name, quote only and create no order: whether the owner orders path exists as written in the report, and whether buying native AVAX through `0xEeee…` quotes. If it doesn't, a purchase pays out in WAVAX and a note says so.
- [ ] **Step 3: Run the tests to see them fail**
- [ ] **Step 4: Implement.** `notes`: `Your funds stay in your wallet until a solver fills this at your price or better.`, `Expires in 7 days.`, `Avalanche has few CoW solvers trading right now, so it may not fill.`, `Cancelling costs a small network fee.`, and for the approval, `This lets CoW move exactly this amount and no more. Cancelling doesn't remove it.`
- [ ] **Step 5: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 6: Commit**: `feat(dapp): sign and place cow limit orders on avalanche`

---

### Task 7: The chat

**Files:**

- Create: `apps/dapp/components/intents/chain-orders-card.tsx`, `apps/dapp/lib/chains/orders-view.ts`, `apps/dapp/lib/__tests__/chain-orders-view.test.ts`
- Modify: `apps/dapp/components/intents/intent-chat.tsx`, `apps/dapp/lib/chains/parse-sequence.ts` (`readChainMessage`), `apps/dapp/hooks/use-chain-action.ts`, `apps/dapp/lib/chains/signing-flow.ts`

**Interfaces:**

- Consumes: Tasks 1, 2, and `thenPrepareAgain`.
- Produces: `ChainMessageRead` adds `{ kind: 'limit'; action: ChainActionRequest }` and `{ kind: 'orders' }`. `ordersAsked(text: string): boolean`. `orderLine(order: RestingOrder): string`. `exitsFor(order: RestingOrder): ('cancel' | 'collect')[]`. `freshExit(listed: RestingOrder, now: RestingOrder | undefined, action): 'cancel' | 'collect' | 'gone'`. The hook adds `prepareExit(orderId, action, text)`.

- [ ] **Step 1: Write the failing tests**

- `readChainMessage('sell 1 SOL at $110', 'solana', 'Solana')` is `limit`. `parseChainSequence` still wins for `swap 1 SOL to USDC then cash out`, and a plain swap stays a plain swap.
- `readChainMessage` on Monad refuses with `LIMIT_NOT_HERE`.
- `ordersAsked` is true for `my orders`, `show my open orders`, `cancel my order`, `limit orders`, and false for `order 5 SOL` and `in order to swap`.
- `exitsFor`: open offers cancel; partly offers cancel and collect where something is collectable; filled offers collect only; done offers nothing.
- `freshExit`: Cancel pressed on an order that has since filled becomes `collect`, and one no longer listed is `gone`, which says `That order is no longer open. Nothing was signed or sent.`
- `orderLine` reads like `Sell 1 SOL at $110, 0.4 filled, expires Nov 12`.
- A settled action with `thenPrepareAgain` keeps the request and offers one `Continue` press, and a press while building does nothing. A settled action without it behaves as today.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** A limit goes straight to the card, with `racesFirst` false. The card shows pay, the price, the least it will receive, the notes, and the cost. After settling, the chat says the order is resting, how to see it (`my orders`), and for Sui and NEAR that collecting takes another signature. The list re-reads on open and after any exit, and each press re-reads the order first (`freshExit`). Chat persists through the existing transcript. Nothing about an order is written to the database.
- [ ] **Step 4: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 5: Commit**: `feat(dapp): place limit orders from the chat, and list, cancel and collect them`

---

### Task 8: The model reads limit orders

**Files:**

- Modify: `apps/dapp/lib/chains/parse-sequence.ts` (`ReadSwap`, `chainRouteFromReading`), `apps/dapp/lib/orchestrate/orchestrate.ts` and its per-chain prompt, `apps/dapp/app/api/intent/orchestrate/route.ts`
- Test: `apps/dapp/lib/__tests__/chain-limit-reading.test.ts`

**Interfaces:**

- Consumes: `parseChainLimit`, `limitSaid`, `LIMIT_NOT_HERE`.
- Produces: `chainRouteFromReading` returns `{ action }` with `kind: 'limit'` when the instruction parses as one and `limitSaid` holds, and otherwise a refusal.

- [ ] **Step 1: Write the failing tests**

- Person: `I want to get rid of 1 sol once it reaches 110`. The model's instruction is `sell 1 SOL at $110`: runs as a limit.
- The same with the model's instruction `sell 1 SOL at $120`: refused.
- A reading with a limit style whose instruction doesn't parse: refused with an example, never turned into a market swap. This is the trap: today a limit reading with `style` ignored would run at market.
- `buy 2 SOL at 90`: refused with `Say how much you will spend, for example "buy SOL with 180 USDC at $90".`
- `sell $5 of SOL at $110`: refused with `Say how much SOL, for example "sell 0.05 SOL at $110".`
- The Stellar prompt hash test still passes.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** The off-Stellar prompt says a stated price or "when it hits" is a limit, written out as `sell <amount> <token> at $<price>` or `buy <token> with <amount> <stable> at $<price>`, and carries `style: 'limit'`. Where Monad is the chain, it says there is none.
- [ ] **Step 4: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 5: Commit**: `feat(dapp): let the model read a limit order, held to the persons own words`

---

### Task 9: Agents recommend a strategy

**Files:**

- Create: `apps/dapp/lib/agents/rest-option.ts`, `apps/dapp/lib/__tests__/agents-rest-option.test.ts`
- Modify: `apps/dapp/lib/agents/brief.ts` (`CHAIN_BRIEF`), `apps/dapp/lib/agents/settle-chain-plan.ts`, `apps/dapp/lib/agents/chain-routes.ts`, `apps/dapp/lib/agents/market-context.ts`, `apps/dapp/lib/agents/chain-race.ts` (`chainRequestFor`, `recommendationLine`), `apps/dapp/app/api/agents/compete/route.ts`, `apps/dapp/components/intents/competition-panel.tsx`

**Interfaces:**

- Consumes: `limitPair`, a chain's `limit` venue and its `limitCost`.
- Produces:
  - `restOption(chainApi, request, marketUsd): RestOption | undefined`, where `RestOption = { venueId: string; venueName: string; marketUsd: number; selling: boolean; cost?: { amount: string; symbol: string }; notes: string[] }`. Nothing unless the request is a swap with a stablecoin side and the chain has a limit venue for that pair.
  - `settleChainPlan(proposal, rest?: RestOption)`: keeps `executionMode: 'rest'` and `restPriceUsd` only when the price is inside the band, and otherwise makes it a fill, as today.
  - `restBand(marketUsd, selling): { least: number; most: number }`: selling 0.1% to 5% above the market, buying 0.1% to 5% below.
  - `chainRequestFor` turns a rest proposal into `{ kind: 'limit', amount, tokenIn, tokenOut, venue: rest.venueId, limitPrice }`, with the amount and tokens from what the person asked.
  - `restAlternativeLine(proposals): string | undefined`

- [ ] **Step 1: Write the failing tests**

- `restOption` is undefined on Monad, for a supply, for a pair with no stablecoin, and when a venue was named.
- `settleChainPlan` keeps a sale resting 2% above the market. It turns into a fill: a sale below the market, one 6% above, a purchase above the market, and `split` always. Without a `rest` argument, it always fills, as today.
- Scoring: a rest proposal never outscores the best measured fill, as it has no measured fill, so `Recommended` stays on measured figures.
- `unanimous` is false when one agent fills and another rests, so the panel doesn't say they agree.
- Off Stellar, a decided race always states one recommended strategy, including when agents agree or only one route exists: `Recommended: fill now via Jupiter. All 2 agents agree. You pick who executes.` The user asked for this, and Stellar's line does not change.
- `restAlternativeLine`: `1 agent suggests resting at $98.00 through Kamino: it could get more, costs about 0.003 SOL, and may never fill. You choose.`
- Pressing Review on a rest proposal prepares a `limit` request whose amount and tokens are the person's, and a route whose amount differs from what was asked is still refused.
- The chain brief names the option only when the market context lists one, and tells agents to weigh the cost against the amount, so a very small swap fills. Stellar's prompt hash test still passes.

- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement.** The panel's card tag reads from `describePlan`, which already handles a rest. A rest card's Review opens the limit card, so the person sees the full terms, and signs only there. Without a limit venue, the race is as it is today.
- [ ] **Step 4: Run all the task's tests, with import-purity and routes-load**
- [ ] **Step 5: Commit**: `feat(dapp): let agents recommend resting an order where a venue can hold it`

---

### Task 10: Whole-branch verification and preview

**Files:** none changed unless a check fails.

- [ ] **Step 1:** From `apps/dapp`: `npx tsc --noEmit`, exit 0. `pnpm exec next lint`, no errors. From the root, Prettier `--check` on the files changed since `feat/chain-sequences`.
- [ ] **Step 2:** `npx vitest run --exclude '**/*.live.test.ts' --reporter=basic --maxWorkers=3 --minWorkers=1`: no failures.
- [ ] **Step 3:** Run the four live tests by exact name. Each only reads and simulates. Record outcomes.
- [ ] **Step 4:** Report whether the combined tree of `feat/chain-limit-orders` and `feat/onchain-venues` merges cleanly (`git merge-tree --write-tree`), without merging anything.

The controller deploys the preview. No task pushes, merges, or touches Production.
