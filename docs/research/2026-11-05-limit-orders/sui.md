# Sui limit orders on DeepBook V3 - research (2026-11-05)

Verdict: BUILDABLE on DeepBook V3, one signature to open and place, with a custom tx builder and a new safety policy. Cetus limit orders are a worse fit (see 6). Funds are never held by us; they sit in a BalanceManager the person owns, and unfilled or filled tokens need an explicit withdraw to return to the wallet.

Evidence legend: [SRC] read from SDK/Move source, [LIVE] queried read-only today, [DOC] docs page, [UNVERIFIED].

## 1. Package, calls, flow

Package: `@mysten/deepbook-v3` 2.10.1 (modified 2026-11-03), repo MystenLabs/ts-sdks, peer dep `@mysten/sui ^2.39.0` [LIVE npm]. Repo pins `@mysten/sui` 2.31.2 (apps/dapp/package.json), so a bump is required. SDK is by Mysten Labs (the protocol author), deps are only axios, @mysten/bcs, axios-retry, @noble/hashes. No postinstall seen in package.json scripts reviewed (I did not audit dist for supply-chain; a Socket listing exists for an older experimental version - UNVERIFIED relevance). Server-safe: it only builds `Transaction` fragments and calls a public indexer; nothing signs. Recommended: do NOT use the SDK client class at runtime on the server for the safety path; use it (or its generated `contracts/deepbook/*` bindings) only to build, and verify bytes independently.

Mainnet ids [SRC src/utils/constants.ts]:
- DEEPBOOK_PACKAGE_ID (core v9, latest, what calls target): `0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8`
- Types live in original package `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809` [LIVE pool object type]. Dynamic fields show `0x00c1a56e...::ewma` and `::pool::ReferralRewards`, i.e. a middle version also appears in types. Policy must allow the latest id only and be updated on upgrade (fits safety.ts "unknown id refused" design).
- REGISTRY_ID `0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d`; DEEP coin `0xdeeb7a46...c270::deep::DEEP`; USDC `0xdba34672...00e7::usdc::USDC`.
- Package ids are NOT the same as the pool id; the pool is a shared object.

Calls (SDK method -> Move target) [SRC transactions/balanceManager.ts, deepbook.ts; Move pool.move main]:
1. Create: `balance_manager::new()` returns BalanceManager (SDK `createAndShareBalanceManager` does `new` then `0x2::transfer::public_share_object<...::balance_manager::BalanceManager>`). Variant `createBalanceManagerWithOwner(owner)` -> `balance_manager::new_with_custom_owner`.
2. Deposit: `balance_manager::deposit<T>(manager, coin)`; SDK builds the coin with `coinWithBalance`, which emits SplitCoins/MergeCoins and, for address-balance funds, `0x2::coin::redeem_funds` etc. (the repo already allows these in safety.ts FRAMEWORK_CALLS).
3. Proof: `balance_manager::generate_proof_as_owner(manager)` -> TradeProof (hot potato-like, needed by every trade call).
4. Place: `pool::place_limit_order<Base,Quote>(pool, manager, proof, client_order_id u64, order_type u8, self_matching u8, price u64, quantity u64, is_bid bool, pay_with_deep bool, expire_timestamp u64, clock 0x6)`. SDK defaults: order_type NO_RESTRICTION, expiry MAX_TIMESTAMP, payWithDeep true. For a maker-only intent use POST_ONLY order_type; for no-surprise-fill use expiry.
5. Cancel: `pool::cancel_order(pool, manager, proof, order_id u128, clock)`; also `cancel_orders`, `cancel_all_orders`, and `cancel_orders_permissionless`-style variants exist. Cancel settles the unfilled funds back to the manager balance (process_cancel -> settle_balance_manager) [SRC pool.move:596-617].
6. Withdraw: `balance_manager::withdraw<T>(manager, amount)` or `withdraw_all<T>(manager)` returns Coin<T>, then `TransferObjects` to the person. Note the SDK's `withdrawFromManager` takes a `recipient` argument - the safety policy must pin it to the account.
7. Read open orders: dry-run `pool::account_open_orders(pool, manager)` -> vector<u128>; `pool::get_order`, `get_orders`, `account(pool, manager)`; or indexer REST `https://deepbook-indexer.mainnet.mystenlabs.com/order_updates/SUI_USDC`, `/trades/SUI_USDC` (fills: price, base_volume, maker_balance_manager_id, fees) [LIVE]. Balance: `balance_manager::balance<T>`.

One signature? Yes, with a caveat. Create + deposit + place can be one PTB, but a shared object cannot be shared and then referenced by ID in the same tx, and the SDK helpers all take a manager ID from config (`getBalanceManager(key).address`). So for first-time setup you must: `new` -> use the returned result argument directly in `deposit`, `generate_proof_as_owner`, `place_limit_order` -> `public_share_object` LAST. That means calling the generated move-call bindings (`balanceManagerMoveCalls`, `poolMoveCalls`) directly with the result handle, not the config-key helpers. This is plausible per Move rules (the object is owned by the PTB until shared) but I did NOT dry-run it - UNVERIFIED; test it with `simulateTransaction` (read-only) before building on it. Returning users (manager exists): deposit + proof + place is one PTB with the manager by ID.

After a fill: a fill settles into the BalanceManager (process_create returns settled/owed, vault.settle_balance_manager) - the bought tokens are credited to the manager's balance, NOT the wallet. Person must call withdraw (second signature) to get tokens back; also true after cancel and expiry. There is a permissionless `withdraw_settled_amounts_permissionless` that credits maker proceeds to the manager (anyone can call it) but it still ends in the manager; only `withdraw` sends to the wallet and requires the owner [SRC pool.move]. Practical flow: place (sig 1) -> wait/monitor -> `withdraw_all` base+quote, in one PTB (sig 2). If cancelled: `cancel_order` + `withdraw_all` in one PTB (one sig). Optionally pre-add the withdraw in a later PTB; there is no auto-withdraw, no keeper.

## 2. Pools, sizes, fees, prices

Pools are shared objects, keyed by (Base,Quote). Mainnet ids [SRC constants.ts mainnetPools; matched against indexer get_pools LIVE]:
- SUI_USDC `0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407`
- DEEP_SUI `0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22`
- DEEP_USDC `0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce`
- WAL_USDC `0x56a1c985c1f1123181d6b881714793689321ba24301b3585eec427436eb1c76d`
- XBTC_USDC `0x20b9a3ec7a02d4f344aa1ebc5774b7b0ccafa9a5d76230662fdc0300bb215307`
- USDSUI_USDC `0xa374264d43e6baa5aa8b35ff18ff24fdba7443b4bcb884cb4c2f568d32cdac36`
Discover all via indexer `GET /get_pools` [LIVE]. Quote is USDC or SUI, so only pairs that exist are tradable; a SUI->USDC sell is the `isBid=false` order on SUI_USDC; a USDC->SUI buy is `isBid=true`.

Validation (order_info.move validate_inputs) [SRC]: quantity >= min_size (EOrderBelowMinimumSize), quantity % lot_size == 0 (EOrderInvalidLotSize), price % tick_size == 0 and within range (EOrderInvalidPrice). Quantity is in base raw units. On-chain price = human price * 1e9 * quoteScalar / baseScalar (SDK convertPrice [SRC conversion.ts]); for SUI/USDC that is price * 1e6.

Live on-chain values for SUI_USDC via read-only simulate of `pool::pool_book_params` / `pool_trade_params` / `mid_price` / `whitelisted` [LIVE, my script scratchpad/di.mjs]:
- tick_size 10 (raw) = 0.00001 USDC; lot_size 100000000 = 0.1 SUI; min_size 1000000000 = 1 SUI.
- WARNING: indexer `/get_pools` reports tick_size 100 for SUI_USDC, which disagrees with the chain (10), and live book prices have 5 decimals (0.92059), consistent with 10. Do not trust the indexer for sizing; read chain.
- trade params: taker fee 200000 (1e9 scale) = 2 bps, maker fee 0, stake_required 100000000000 = 100,000 DEEP. Not whitelisted (so DEEP fee or input-token fee applies). Per docs the whitelisted pools (DEEP_SUI, DEEP_USDC) are 0 fee [DOC docs.sui.io/standards/deepbookv3/design].
- Other pools (indexer, units may be off as above, verify on chain): DEEP_USDC min 10 DEEP lot 1 DEEP tick 10000; XBTC_USDC min 1000 lot 1000 (8 decimals) tick 1e7; WAL_USDC min 1 WAL lot 0.1 WAL; DEEP_SUI min 10 lot 1.
- Mid price: dry-run `pool::mid_price(pool, clock)`; returned 918740 = 0.91874 USDC [LIVE]. Alternatively indexer `/orderbook/SUI_USDC?level=1&depth=1` gave best bid 0.92106 / ask 0.92143 at fetch time; mid = (bid+ask)/2. Last trade ~0.92126.

Fees and DEEP: place_limit_order has `pay_with_deep`. Move doc comment says "For current version pay_with_deep must be true", but the code path for false exists (empty deep price, input-token fee; `get_quantity_out_input_fee`, `can_place_limit_order` input-fee paths) [SRC pool.move:178, :1996-2010]. Whether false is actually accepted by deployed v9 for non-whitelisted pools is UNVERIFIED - dry-run to find out. If true, the BalanceManager must hold DEEP for taker fees on any part that crosses; a maker-only (POST_ONLY, resting) order that never takes pays maker fee 0, but the book still reserves DEEP for fees owed at place time per DEEP price. Needs DEEP deposit in practice -> a real onboarding burden. Use `get_order_deep_required` to compute. Live fills show `taker_fee_is_deep: true` and tiny fees (0.1057 DEEP for $16.76 trade).

## 3. Safety check before signing (what assertPtbSafe needs for DeepBook)

Repo state [SRC apps/dapp/lib/chains/sui/safety.ts, policies.ts]: `assertPtbSafe(payload, account, policy)` parses BCS, checks sender and gas owner = account, rejects non-Sender FundsWithdrawal, allows only SplitCoins/MergeCoins/TransferObjects (recipient pinned to me)/MoveCall in an allow-list of exact `pkg::module::function`, and routes each call to `policy.checkCall(call, readPure, account)`. Venues in policies.ts: springsui, cetus, navi. DeepBook appears only in venues.ts. A new `DEEPBOOK_POLICY` is needed. Note `public_share_object` and `new` are not in FRAMEWORK_CALLS: add exact `0x2::transfer::public_share_object` only with type arg pinned to `<DEEPBOOK_PKG or original>::balance_manager::BalanceManager` (do not allow the generic framework module; it can share anything).

Allowed calls (latest pkg `0xbca0cefe...`): `balance_manager::{new, deposit, withdraw, withdraw_all, generate_proof_as_owner}`, `pool::{place_limit_order, cancel_order, cancel_orders, cancel_all_orders}`, `0x2::clock` by shared object 0x6. Do NOT allow `mint_trade_cap`, `mint_deposit_cap`, `mint_withdraw_cap`, `register_balance_manager`, `set_owner`/`new_with_custom_owner`, or any `*_cap`: those hand control of the manager to another address.

checkCall must verify, from literal Pure inputs (reject anything not a Pure input, as `ReadPure` already does):
- pool: the pool object input id equals the expected id from our own table for the asked pair AND type arguments equal [Base,Quote] for that pair (typeArguments exactly; a wrong type argument pair aborts, but a wrong pool with right types is a different-market risk e.g. a look-alike). Pool object must be the shared input with the expected id; since ids come through `Input` Object not Pure, readPure cannot read them - need an object-id check (data.inputs[n].UnresolvedObject/SharedObject.objectId); extend the policy API (current `ReadPure` only reads Pure).
- side: is_bid (Pure bool) equals the asked side.
- price: u64 equals expected raw price, computed by us from the human price with ticks (`price % tick == 0`, rounded in the person's disfavour never in ours), and within a sanity band of live mid (for example limit within a stated percent, or at least warn if a sell is far below mid / buy far above mid = would fill immediately at a worse price than asked; do cap it, since a limit order that crosses the book is a market order).
- quantity: u64 equals asked base raw amount, multiple of lot_size, >= min_size.
- order_type, self_matching, expiry (u64 ms): order_type pinned (POST_ONLY or NO_RESTRICTION as product decides), expiry within allowed window; `pay_with_deep` matches the fee mode we funded.
- deposit: the Coin argument must come from our SplitCoins with amount equal to quantity (sell: base qty; buy: price*qty in quote plus fee margin). Verify the SplitCoins amount Pure equals the expected deposit and coin type = expected. The balance manager argument for deposit/proof/place must be the SAME handle (result of `new`, or the person's known manager id). If an existing manager id is used, verify on chain that it exists, is a BalanceManager, and `owner == account` (read via GraphQL object), because depositing into a manager owned by someone else is a theft vector. For `new` in the same PTB the owner is ctx.sender, i.e. the account (new_with_custom_owner must be refused).
- withdraw: `withdraw`/`withdraw_all` result must flow only into a TransferObjects whose recipient == account (already enforced) and amount ok. Cancel: order_id plausible and the manager is the person's.
- No extra commands: default branch already refuses anything unknown (MakeMoveVec, Publish, Upgrade, etc.).
- After build, re-run on the signed bytes (as the repo already does) and simulate (`simulateTransaction`) to assert balance changes: person's sell-token decreases by exactly deposit amount, nothing else leaves. The DeepBook move-call-level check alone cannot see value flow.

Hard check on clientOrderId and DEEP: client_order_id is harmless. Gas: SDK sets a fixed gas budget constant; the repo's own flow should set it.

## 4. Is it live

- Mainnet package ids above; core v9 live [SRC + LIVE: calls to `pool_book_params` etc. at `0xbca0cefe...` succeeded in simulation today].
- SUI/USDC 24h (indexer `/summary`, fetched 2026-11-05) quote volume about $4.55M, 4.89M SUI, last 0.92126, top-of-book spread 0.92106/0.92143 (about 4 bps), 1.5% 24h change [LIVE]. Orderbook depth at top about 2.2k SUI per side, level-2 about 1-4k SUI: thin; sizes of a few hundred SUI are fine, five-figure SUI will move the price [LIVE]. Other pools: DEEP_USDC ~$112k/24h, XBTC_USDC ~$1.0M, USDSUI_USDC ~$0.73M; WUSDT_USDC, TYPUS_SUI zero volume [LIVE]. Many pools are dead.
- Audits: OtterSec is listed (third-party database) as auditing DeepBook V3, April 2025; report contents not seen; earlier OtterSec findings on the first DeepBook (Aug 2024) include a high "trade proof bypass" [UNVERIFIED, secondary source: movemaverick.github.io vulnerability database; OtterSec index https://ottersec.notion.site/Sampled-Public-Audit-Reports-a296e98838aa4fdb8f3b192663400772]. deepbookv3 repo has no `audits` folder (GitHub API 404) and a SECURITY.md [LIVE]. I found no MoveBit audit of V3.
- Incidents: none found for DeepBook V3 in a web search (UNVERIFIED negative; search was shallow). The separate Cetus exploit (May 2025, about $220-260M) is unrelated to DeepBook.
- Upgrade cadence is high (core v9, margin v8, SDK changelog shows many id bumps), so the allow-list needs a maintained pin and an alarm when the registry's allowed version changes. `EPackageVersionDisabled` (error 11) aborts old package calls after governance disables a version.

## 5. Sources
- https://docs.sui.io/standards/deepbook (overview only)
- https://docs.sui.io/standards/deepbookv3/design (fee bounds, settlement)
- npm `@mysten/deepbook-v3@2.10.1` tarball, src/transactions/{balanceManager,deepbook}.ts, src/utils/{constants,conversion}.ts
- https://raw.githubusercontent.com/MystenLabs/deepbookv3/main/packages/deepbook/sources/pool.move and book/order_info.move
- https://deepbook-indexer.mainnet.mystenlabs.com/{get_pools,summary,ticker,orderbook/SUI_USDC,trades/SUI_USDC,order_updates/SUI_USDC}
- Sui GraphQL https://graphql.mainnet.sui.io/graphql and gRPC simulate on https://fullnode.mainnet.sui.io:443 (note: JSON-RPC is disabled on public fullnodes, matches repo client.ts)
- Repo: apps/dapp/lib/chains/sui/safety.ts, policies.ts, venues.ts

## 6. Cetus limit orders (brief)
- Product: on-chain limit order, default 7-day expiry up to one month, unfilled returned at expiry, filled tokens auto-sent to wallet, partial fills held on chain until claimed [DOC https://cetus-1.gitbook.io/cetus-docs/guides/how-to-place-a-limit-order]. SDK `@cetusprotocol/limit-sdk` 1.2.6 exposes place_limit_order, cancel_order, claim_target_coin (grep of dist/index.js); I found no user-callable fill/execute function in the SDK.
- Who executes: not documented. Docs say orders run "when the price is triggered"; with no public fill entry point in the SDK, execution is almost certainly by Cetus-operated off-chain keepers/bots (inference, UNVERIFIED). That adds a trust and liveness dependency on Cetus (orders may not fire; they cannot be filled by the open market the way a resting DeepBook order can), and prices may fill at Cetus AMM prices with slippage rather than book prices.
- DeepBook is a true on-chain CLOB: resting orders fill whenever any taker crosses, no keeper. Better for "non-custodial, we only build a tx" because no operator can fail to execute. Cetus' upside: tokens auto-delivered to wallet (no second withdraw), no BalanceManager and no DEEP. Downside: opaque executor and weaker evidence base. Recommendation: DeepBook for fidelity to a limit price; Cetus only if the second-signature/DEEP friction proves too heavy, after reading its contract source and package ids (not done here).

## 7. Verdict, risks, what a person can lose

Buildable: yes. Not tested end-to-end (no wallet, no tx submitted).

Main risks:
1. BalanceManager custody model: funds sit in a shared object whose ownership is the person's address. Wrong-manager deposit (not owned by them) or a minted TradeCap/DepositCap/WithdrawCap held by another party loses funds. Mitigation: owner check on chain, ban cap calls.
2. Shared-object-in-same-PTB behaviour for create+deposit+place is unproven; fallback is two signatures for first use.
3. DEEP fee requirement: `pay_with_deep` documentation says must be true; people without DEEP could see aborts or have to buy DEEP. Dry-run `pay_with_deep=false` before promising an input-fee path.
4. Order crosses the book: a buy limit above ask fills at once as taker at market (up to 2 bps taker fee plus slippage on thin book); POST_ONLY avoids it but aborts/rejects if it would cross.
5. Indexer data can disagree with chain (tick_size 100 vs 10). Chain is the source of truth for sizing.
6. Thin liquidity beyond about 2-4k SUI per level; fills may be partial and rest for a long time; stale price risk (a resting order can fill into a market move; expiry mitigates). Dust sizes: min 1 SUI.
7. Package upgrades: pins go stale; a new package id blocks the venue until reviewed (safe failure per safety.ts).
8. Smart-contract risk: audit evidence only secondary; earlier DeepBook had a trade-proof bypass finding (fixed per V3 audit? UNVERIFIED).
9. Two-signature exit: tokens stay in the manager until the person withdraws. UX must show "ready to withdraw" and never leave it implied they are in the wallet.

What a person can lose: worst case, the full deposited amount if the manager owner/caps are wrong or the contract has a bug; in normal use, taker fee on crossing size (2 bps plus DEEP purchase cost), slippage if the order crosses, plus gas for the extra withdraw signature; unfilled funds are not lost, they are recoverable by cancel+withdraw at any time without a counterparty (nobody else can cancel). Exchange-rate risk while waiting is inherent to a limit order.
