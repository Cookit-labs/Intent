# NEAR limit orders on Rhea/Ref DCL (dclv2.ref-labs.near) - research, 2026-11-05

## Corrections from the build, 2026-11-05

Read off mainnet with nothing signed (`near-rhea-dcl.live.test.ts`, plus real transactions on this pool read through `EXPERIMENTAL_tx_status`). Where this differs from the report below, this section is right.

- **No sign flip on the pool's axis.** The UI's `-point` only turns its helper's "B per A" price into the pool's y-per-x, so what goes in `msg` is one axis either way: USDC per NEAR = 1e18 / 1.0001^point, whichever token is sold. Selling NEAR rests below `current_point`, buying NEAR above it. Real resting orders agree: #8665 sells USDC at 415439 (0.9091 USDC per NEAR) against a market at about 401300, and the book near the market has only sell-NEAR orders below the point and sell-USDC above it. A fill matched the point to 8 digits: order #16180, 130.344448 NEAR at 401041 bought 500.004597 USDC, or 3.8360253 per NEAR against 3.8360253 at the point, so no maker fee shows.
- **A purchase pays out in native NEAR, not wNEAR.** `cancel_order {order_id, amount}` makes the contract call `wrap.near.near_withdraw` and transfer native NEAR. Seen on this pool with `amount: "0"` in `3b2gaLoDMLtDhR6YvjWeCGo2jN7r2XNXnXbo3PkxD5nL` (500 NEAR bought) and `9ToL4GV74Z3oggetFvHb6LdogxSRd2QFDR1yZf1S1tK4`. A cancel returning sold wNEAR does the same (`23U4s6vFXWTf47HzR6QwqgddmyMDpKrHL7adGkYBuzUJ`, on another pool). There is an undocumented `skip_unwrap_near: true` to keep wNEAR, which market makers pass. This app doesn't, and refuses it. So the section 3 note, "proceeds come back as wNEAR", is wrong for this call.
- **Collect and cancel pay the wallet.** USDC bought arrives by `ft_transfer` in the same transaction (`4MAGH8AXzcMgPjU5nC8ZDXRo6AjAVdF5SUady6LZD9oh`). The SDK's comment about an "inner account" doesn't describe what happens here.
- **An `amount` above what is left is cut.** In that same transaction, a request to cancel 72.4 NEAR of an order already filled logs `actual_cancel_amount: "0"`, succeeds, and pays out the fill.
- **`bought_amount` includes `unclaimed_amount`**, and a filled order stays in `list_active_orders` with `remain_amount: "0"` until collected (#15820: 999 USDC at 400927, both 257.47 NEAR). `get_order` answers `null` once an order has closed. `unclaimed_amount` is `null` in history rows.
- **`find_order` answers `null` when nothing rests at that point.** A second order at the same point fails rather than merges: `E301: active order already exist` is in the deployed bytes (`view_code`, hash 3G34Nh...), and `internal_add_order` in the public fork below requires it. The app refuses it first.
- **Gas.** Storage 30 + `near_deposit` 30 + `ft_transfer_call` 250 is 310 TGas, over the 300 limit the report said it fit in. Storage goes in its own transaction anyway.
- **Several transactions don't carry a first use safely.** NEAR Connect hands the array to the wallet, which promises neither order nor stopping after a failure, and throws with no hashes if it fails partway. Rhea's own interface does send one array. An order landing without its storage should panic (`E100: account not registered`, `E102: insufficient storage`, `E107: not enough storage for slots` are in the bytes) and NEP-141 would refund it, as wNEAR if it was wrapped. The app pays for storage alone, with `thenPrepareAgain`, then builds the order once the chain shows the storage.
- **An order's own status doesn't say it rested.** If `ft_on_transfer` refuses, NEP-141 refunds and the transaction still succeeds. Submit looks for the order with `find_order`, and reads a miss as pending.
- **`LimitOrder` exists beside `LimitOrderWithSwap`, and this app keeps `LimitOrderWithSwap`.** The deployed bytes list `TokenReceiverMessage::LimitOrder` with 4 fields and `LimitOrderWithSwap` with 6. No real mainnet use of the plain one was found, on 5 November 2026, read through nearblocks: 0 among 358 recent `ft_transfer_call`s naming dclv2 on USDC and wrap.near (8 pages of 25 on each), and 0 against 138 `LimitOrderWithSwap` in 5 recent pages each of six accounts that place orders on dclv2 (mmt-arb, rhealover, 9dbdd4...4bb6, i1156173191.tg, bim, doublerose). This is a bounded sample, not the whole history. So it fails the bar of live use on this pool, and its behaviour on mainnet stays unread.
  - What is known of it, none of it from a mainnet transaction. A public fork (`shawn10359/burrowland`, `contracts/mock-dcl`, not the deployed code) has its 4 fields as `client_id, pool_id, buy_token, point`, and `internal_add_order` panics with `E202: illegal point` on a crossed point: selling x needs `point >= current_point`, selling y `point <= current_point`. A third party's notes say the same from testnet (`sleetplayground/near-kit-tool-box-skills`). If the deployed contract does this, the plain message would close the crossing race, so it is worth one real test when someone signs a first order.
  - The same fork bounds `LimitOrderWithSwap`'s swap at the order's own point, and its 6 fields would be these 4 plus `skip_unwrap_near` and `referral_id`, the last from INTEAR's indexer and those notes. That would make the "no minimum out" in section 3 a price bound, less any pool fee. One real crossed order agrees: #15815 buys NEAR at 400894 (3.89283), and swapped 11.6% of its deposit at 3.89283. One order is not proof, so the app still refuses a crossed point.
- **Still unverified:** whether the 0.5 NEAR storage comes back, and how the deployed contract behaves in the cases above, as its source remains unpublished. No order has been signed through this app.

Verdict: BUILDABLE for USDC/wNEAR (and a few other pairs), with a larger safety.ts change than any current NEAR venue (it refuses ft_transfer_call today). Not run end to end; no tx was sent.

## Sources
- SDK (source): https://github.com/ref-finance/ref-sdk/blob/main/src/dcl-swap/limit-order.ts , dcl-pool.ts, swap.ts (last push 2026-02-01); also rhea-sdk (same files).
- UI (source of the place-order call): https://github.com/ref-finance/ref-ui/blob/main/src/services/swapV3.ts (v3Swap, LimitOrderWithSwap, cancel_order, get_user_storage_detail, priceToPoint, pointToPrice).
- Guide: https://github.com/ref-finance/guide/blob/main/near-chain-guides/swap/limit-orders.md (guide.ref.finance did not resolve from here; read via GitHub).
- Contract Rust source: NOT found. ref-finance org has no ref-dcl repo (listed all org repos). Everything on the contract below comes from SDK/UI code plus live view calls. Unverified where noted.
- Live RPC: rpc.mainnet.near.org view calls on dclv2.ref-labs.near.

## 1. Methods and args
Contract: `dclv2.ref-labs.near` (get_metadata: version 2.4.2, state Running, owner ref-finance.sputnik-dao.near, wnear_id wrap.near, protocol_fee_rate 2000 (=20% of pool fee, unverified meaning), 6432 pools, 8010 users).

Place (UI swapV3.ts, LimitOrderWithSwap branch), on the SELL token contract:
```
ft_transfer_call {
  receiver_id: "dclv2.ref-labs.near",
  amount: <sell amount, raw>,
  msg: JSON.stringify({ LimitOrderWithSwap: { client_id: "", pool_id, buy_token, point } })
}  gas 250 TGas, deposit 1 yoctoNEAR
```
- pool_id = "tokenX|tokenY|fee", tokens sorted lexicographically (getDCLPoolId). For USDC native: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|<fee>`; USDC is token_x, wNEAR token_y.
- point sign: UI computes point for price A-by-B, then `new_point = (poolTokenX == sellToken) ? point : -point`. Point must be a multiple of the pool's point_delta (UI floors: regularizedPoint). The point is the ORDER price in the pool's x->y axis; the "LimitOrderWithSwap" name means it first swaps whatever part is already marketable, then rests the rest (original_deposit_amount vs swap_earn_amount fields confirm this).
- Before it, UI prepends: (a) `storage_deposit` on the buy token for the user if unregistered (registration_only); (b) `storage_deposit` on dclv2 if get_user_storage_detail says more slots are needed. If the user has no record: attaches 0.5 NEAR with registration_only true. Otherwise slot_price * max(needed,10) (+ locked_near if not sponsor). Check `get_user_storage_detail {user_id}` (returned null for a random unregistered account, so first-time = 0.5 NEAR). Unverified: whether 0.5 NEAR is refundable (the contract tracks locked_near/slots; likely refundable, not confirmed).
- If selling NEAR: UI prepends near_deposit on wrap.near (and storage_deposit on wrap.near if unregistered).

Cancel: `dclv2.ref-labs.near.cancel_order {order_id, amount}` amount = remain_amount (SDK) or omitted (UI = cancel all). 180 TGas. SDK/UI attach NO deposit (no yocto). Returns unsold tokens plus any bought tokens in the same call (guide).
Claim: SDK `claim_order` = `cancel_order {order_id, amount:"0"}`, 180 TGas, no deposit. Pays out the bought tokens to the wallet, leaves the unfilled portion open (guide). So proceeds are NOT automatic: a fill sits as unclaimed_amount until the owner calls claim (guide: "no time limit"). Unverified: whether amount omitted vs "0" differ.

Reads (all verified live):
- `list_active_orders {account_id}`, `list_history_orders {account_id}`, `get_order {order_id}`, `find_order {account_id,pool_id,point}`, `get_pointorder_range {pool_id,left_point,right_point}`, `get_pool {pool_id}`, `list_pools {from_index,limit}`, `get_user_storage_detail {user_id}`.
- Live order sample (doublerose.near): order_id `"<pool_id>#8665"`, point 415439, sell_token USDC, original_amount 1000000, remain_amount 1000000, bought_amount 0, unclaimed_amount 0. Fields: original_deposit_amount, swap_earn_amount, original_amount, remain_amount, cancel_amount, bought_amount (accumulated), unclaimed_amount (filled, not yet claimed). Fill state = remain_amount vs original_amount, claimable = unclaimed_amount. History order = remain_amount "0".
- order_id format: `<pool_id>#<n>`. The order id is not known at place time; find it afterwards via find_order(account,pool,point) or list_active_orders (the UI parses the tx result log).

## 2. Pools and price math (live, final block ~223163188)
Native USDC / wNEAR pools (current_point, NEAR price at the pool, liquidity):
| fee | point_delta | current_point | USDC per NEAR | TVL (x USDC / y NEAR) | resting order totals |
|---|---|---|---|---|---|
| 100 (0.01%) | 1 | 400630 | 3.997 | 288,390 USDC / 65,101 wNEAR | 4,684 USDC / 13,582 wNEAR |
| 2000 (0.2%) | 40 | 400609 | 4.005 | 3,913 / 84,665 | 107.6 USDC / 3,096 wNEAR |
| 400 (0.04%) | 8 | 393696 | 8.0 (stale) | ~11 / 10 | dust |
| 10000 (1%) | 200 | 397600 | 5.4 (stale) | 0 | none |
Also USDT.tether-token.near / wrap.near fee 100 (point 400559, ~$4.03, ~6.4k USDT) and fee 2000. USDC/wNEAR fee 100 is the one with real depth. Fee tier list: 100, 400, 2000, 10000 (DCL_POOL_FEE_LIST). Fee -> point_delta: 100->1, 400->8, 2000->40, 10000->200 (matches live data).

Conversion: raw price y/x at point p = 1.0001^p. USDC(6 dec)=x, wNEAR(24)=y: NEAR priced in USDC = 1 / (1.0001^p * 1e6/1e24) = 1e18 / 1.0001^p ... checked: p=400630 -> 3.997 USDC/NEAR. Inverse: p = round(ln(1e18/priceUsdcPerNear)/ln(1.0001)) then floor to point_delta (fee 100: delta 1 so ~0.01% steps). Sign flips depending on which token is sold (see above); the SDK's priceToPoint/getPointByPrice does this and must be copied or called, and tested against a live order: doublerose's order sells USDC at point 415439 in pool x=USDC (sell==x so point positive): 1e18/1.0001^415439 = 0.9856e... compute in tests, i.e. a limit order selling USDC for NEAR sits at a LOWER NEAR-per-USDC rate than... (verify with a test, do not trust my sign reasoning; unverified).
Resting depth at the fee-100 pool near the market (get_pointorder_range 399000-402000): sell-NEAR orders (amount_y) at 399922, 399052, 400608; sell-USDC orders (amount_x) at 400927 ... 401986. i.e. orders above/below the current point 400630 on the expected sides, so the book is used by real people.

## 3. Fill mechanics
- DCL is bin-based; an order sits at one point and fills when swaps push the pool price through that point (the pool's own swaps consume resting orders at that point; guide: partial fills happen, both Claim and Cancel enabled). Source not read; per guide + order fields. LimitOrderWithSwap also immediately swaps the marketable part at placement (swap_earn_amount).
- Partial fills: yes (remain_amount shrinks, unclaimed_amount grows). Cancel returns unsold part plus bought part.
- Min size: no min seen in SDK/UI code. UI only checks output >= 0.00000001 and NEAR min balance. Storage slots (see above) are the real cost. Unverified on-chain min.
- Fees: no cancel fee (guide). Trading fee on the filled part: unverified/ presumably the pool fee tier; protocol_fee_rate 2000 in metadata.
- Lost/stuck risks: (1) fill must be claimed by a second tx (a cancel_order amount 0) and the buy token must be registered for the user on its contract or the payout can fail; the UI registers it first. (2) Order never fills if price does not cross; ordinary. (3) ft_transfer_call refunds unused tokens if ft_on_transfer fails/errs (NEP-141), standard. (4) A tiny pool/fee tier with no liquidity (e.g. fee 10000) can have stale price and an order placed on the wrong side of price fills instantly at a bad rate through the swap part, since LimitOrderWithSwap swaps first at whatever price. Mitigation: only allow pool_ids from the app's allowlist and require point within X ticks of current_point, read from get_pool at build time.
- wNEAR: place works on wrap.near ft_transfer_call; the UI wraps first with near_deposit. Proceeds come back as wNEAR (ERC-like ft payout), not native NEAR; the user would need a separate near_withdraw (unwrap) - check how the app's existing swap does (apps/dapp/lib/chains/near/swap.ts/tokens.ts: WRAP_NEAR is in SWAP_CONTRACTS).

## 3b. Repo fit (apps/dapp/lib/chains/near/safety.ts)
- safety.ts allows only calls on wrap.near/USDC/USDT whose LAST call is `ft_transfer` to a 64-hex deposit address, or a stake. Header says `ft_transfer_call` is explicitly refused. A limit order needs:
  - New asserter e.g. assertDclLimitOrderSafe: receiverId in {wrap.near, USDC, USDT}; calls = [storage_deposit(you, registration_only) on buy token?, storage_deposit on dclv2 with a capped deposit (<= 0.5 NEAR + slots; cap e.g. 1 NEAR), near_deposit?, ft_transfer_call]; ft_transfer_call args exactly {receiver_id:"dclv2.ref-labs.near", amount, msg}; msg parsed and required to equal exact-key JSON LimitOrderWithSwap{client_id:"", pool_id from allowlist, buy_token = the other token, point multiple of delta}; deposit exactly 1; gas <= 250 TGas (total <= 300 TGas holds with near_deposit 30 + storage 30). The existing hasExactKeys / isDigits helpers fit. Multiple transactions in the UI sequence (separate storage deposit to dclv2 is a different receiverId, so it needs more than one tx; readSingleTransaction demands exactly one). Either allow a 2-step sequence or put storage_deposit(dclv2) as a separate prior transaction signed under its own asserter.
  - Cancel and claim: receiver dclv2.ref-labs.near, method cancel_order, args {order_id, amount}, deposit 0, gas <= 180 TGas, order_id must be verified to belong to the account via get_order (owner_id == account) server-side.
- Balances/order read: use list_active_orders via the existing rpc.ts view path.

## 4. Is it live
- Contract live: code_hash 3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo, storage 27 MB, ~9.6k NEAR balance; nearblocks shows swaps going through ft_on_transfer at the time of my query (block 223163499, ~now) and 56.5M txns total. 6432 pools, 8010 users.
- Limit orders in use: doublerose.near (a Ref operator in metadata) has active order #8665 created 2026-02 on the USDC/wNEAR fee 100 pool; real resting orders on the book (107 to 1,000 USDC per point). Order activity volume not measured (unverified how many placements this month).
- Upgradeability: `view_access_key_list` on dclv2.ref-labs.near returns NO keys (locked account). Owner field = ref-finance.sputnik-dao.near (DAO), operators doublerose.near and bim.near. Upgrade only via the contract itself (self-upgrade by owner) / DAO proposals; a single key cannot redeploy it. Operators can presumably pause/ set state (unverified - metadata has `state: Running` and operators; I could not read the Rust).
- Audits: BlockSec "blocksec_ref_finance_dcl_v1.0_signed.pdf" and "blocksec_ref_finance_dcl_v2.0_signed.pdf" are in https://github.com/ref-finance/guide/tree/main/.gitbook/assets (PDFs not read; unverified findings). Plus Ref Finance Security Audit 1 and 2 PDFs in the same folder.
- Incidents: none found in this pass (did not search exhaustively). Ref's earlier Ref Exchange had an exploit history? unverified; not searched.

## 5. Verdict
Buildable. Mechanically simple: one ft_transfer_call to place (plus storage deposits), cancel_order to cancel or claim, list_active_orders to read. Needs: a new strict asserter, a multi-transaction sequence (storage), point math ported and tested (sign flip trap), a claim step for the user (not automatic), and wNEAR in/out handling.

Main risks:
1. Not automatic: a filled order pays nothing until the user claims, and the claim is a separate signature. UI must show unclaimed_amount and offer Claim (or Cancel).
2. LimitOrderWithSwap swaps the marketable part immediately. A mis-signed point sells at market with no min_output guard. Pre-check against current_point with a tolerance, and compute with the tested converter.
3. First use costs up to 0.5 NEAR storage deposit plus slot fees (refundability unverified).
4. Thin liquidity outside USDC/wNEAR fee 100 and USDT/wNEAR fee 100; stale prices on fee 400/10000 pools. Allowlist pool ids.
5. Contract source not public; behaviour known from SDK/UI and live views only. DCL v1 and v2 audited by BlockSec, owner is a DAO, no access keys.
6. cancel/claim attach no yocto deposit in the SDK; a wallet-signed call with 0 deposit is lower risk for the asserter but should be dry-run in testing.

What a person can lose: the sold amount is moved to the DEX contract; the worst real cases are a wrong point that fills at a bad rate immediately, an order never filled (cancel returns funds, no fee), unclaimed proceeds left in the contract (not lost, claimable any time), and the storage NEAR if not refundable. A contract bug or a DAO/operator pause would trap funds; the risk is bounded by audit and the large live use. Nothing here is verified by sending a transaction.
