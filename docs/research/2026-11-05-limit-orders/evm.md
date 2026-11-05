# Limit orders on Avalanche (CoW) and Monad: research report

Date: 2026-11-05. Read-only: SDK tarballs, public RPC reads, CoW API GET and one POST /quote (a quote creates no order). No wallet, no .env.local, no repo edits.
Tags: [V] verified live or from SDK source, [D] from docs only, [U] unverified.

## A. Avalanche with CoW Protocol

### Verdict: BUILDABLE. Main work is adding typed-data signing; the protocol side is live and proven.

### A1. Live status [V]
- API base https://api.cow.fi/avalanche/api/v1 answers. GET /version returned v2.386.0@9302627.
- Chain id 43114 (AVALANCHE in @cowprotocol/sdk-config 2.11.2, SupportedChainId). cow-sdk 9.3.3 is current on npm.
- Settlement GPv2Settlement 0x9008D19f58AAbD9eD0D60971565AA8510560ab41. Code present on Avalanche RPC. Same address on all CoW chains (https://docs.cow.fi/cow-protocol/reference/contracts/core, which lists Avalanche).
- Vault relayer GPv2VaultRelayer 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110. Confirmed by calling vaultRelayer() on the Avalanche settlement contract.
- WAVAX 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7 (SDK wrapped-native table). USDC 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E is accepted by the API (native_price returns).
- Eth-flow contract 0xba3cb449bd2b4adddbc894d8697f5170800eadec (SDK ETH_FLOW_ADDRESSES applied to all chains). Code present on Avalanche. The SDK maps it to every chain, so treat Avalanche use as [V] for code, [U] for behaviour (no native order seen).
- Live quote: POST /quote, sell 1 WAVAX to USDC, returned buyAmount 8728855 (8.73 USDC), feeAmount 1387297418112970 wei, protocolFeeBps "2", verified true.

### A2. Live evidence of fills [V]
Trade events on the settlement contract in the last ~30k blocks: 6 trades. For three, GET /orders/{uid} returned status "fulfilled", for example:
- 0xec15a509...a7e5fd2dff540b19e542a92cb824aac9ebef05c9586c46aec6bf4 (owner 0xd2dff5..., created 2026-11-05 11:14Z, executedSellAmount 200034, executedFee 17884, class "limit", AAVE v4 swap with hooks).
- 0x9e31cc36...6646 and 0x80f42c75...6677 (owner 0x44afcc..., Safe Wallet Swaps, partner fee 70 bps, fulfilled).
Caveat: these are market-intent swaps; the API tags every order class "limit" because fees are surplus-based. I did not find a user-set limit order far from market. Fill mechanics are the same. A human limit order resting for days on Avalanche is [U].
Liquidity is thin: 6 trades in about 30k blocks, so a limit order may wait. Solver 0x8cd4beaa... seen on quotes.

### A3. Flow
1. Approval (EVM tx). ERC-20 approve(vaultRelayer 0xC92E...0110, amount) on the sell token. Exact amount, not unlimited. A new tx type is not needed; the current `{family:'evm', to, data, value:'0'}` path covers it.
2. Sell token must be an ERC-20. Native AVAX is not directly sellable by a signed order.
   - Option 1: wrap to WAVAX first (WAVAX.deposit() payable, one tx), then approve, then sign.
   - Option 2: eth-flow contract. SDK getEthFlowTransaction calls createOrder on the eth-flow contract with the AVAX as value. This is an on-chain order, one tx, no signature. Cancel is on-chain invalidateOrder; the order is invalidated by its creator or by anyone after expiry, and auto-refund applies only at >=2% slippage (https://docs.cow.fi/cow-protocol/reference/contracts/periphery/eth-flow). Eth-flow orders are sell-only, with buy token an ERC-20.
   - Receiving AVAX (buying native): buyToken 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (BUY_ETH_ADDRESS in contracts-ts) [D/V in SDK].
3. Quote (optional but wise): POST /quote to get fee and a reference price. For a limit order the signed feeAmount must be "0"; the solver takes a surplus fee in the sell token (executedFee seen on filled orders) [V from orders, rule from SDK trading code].
4. EIP-712 sign. Domain `{name:"Gnosis Protocol", version:"v2", chainId:43114, verifyingContract:0x9008...ab41}` (contracts-ts static domain()). Primary type `Order`, fields in order [V, ORDER_TYPE_FIELDS]:
   sellToken address, buyToken address, receiver address, sellAmount uint256, buyAmount uint256, validTo uint32, appData bytes32, feeAmount uint256, kind string ("sell"/"buy"), partiallyFillable bool, sellTokenBalance string ("erc20"), buyTokenBalance string ("erc20").
   ORDER_TYPE_HASH 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489.
   Note: in the API JSON, appData is the full JSON string and appDataHash the bytes32; the signed field is the hash. Create/stash the app-data JSON (PUT /app_data/{hash} or send fullAppData with the order). GET /app_data/0x00..00 returns "{}", so the empty hash works.
5. POST /api/v1/orders with: sellToken, buyToken, receiver, sellAmount, buyAmount, validTo, appData (+appDataHash), feeAmount "0", kind, partiallyFillable, sellTokenBalance, buyTokenBalance, signingScheme "eip712", signature (65-byte hex), from. Response is the order UID (56 bytes: digest 32 + owner 20 + validTo 4). UID = hashOrder(domain, order) + owner + validTo; compute it locally and compare to the response.
6. Limit semantics: sell order = sellAmount fixed, buyAmount is the minimum out; buy order = buyAmount fixed, sellAmount is the maximum in. The price a person types sets buyAmount. Any fill at or above that is surplus to them.
7. Smart-contract wallets: use EIP-1271 or presign (setPreSignature on settlement, on-chain tx). EOAs use eip712 (or ethsign).

### A4. Cancellation
- Off-chain (free): DELETE /api/v1/orders, body `{orderUids:[...], signature, signingScheme:"eip712"}`; typed data primary `OrderCancellations{bytes[] orderUids}` with the same domain (CANCELLATIONS_TYPE_FIELDS, hashOrderCancellations). Best-effort: a solver already settling can still fill it. [V in SDK; exact DELETE body is [U] — read from order-book SDK before building]. Cancel pages at docs.cow.fi returned 404 for the URL I guessed.
- On-chain: GPv2Settlement.invalidateOrder(bytes orderUid) from the owner. Definitive, costs gas. Eth-flow orders: invalidateOrder on the eth-flow contract.
- Expiry cancels everything on its own (validTo).

### A5. Reading state
- GET /orders/{uid}: status (open, fulfilled, cancelled, expired, presignaturePending), executedSellAmount, executedBuyAmount, executedFee, invalidated, creationDate. [V]
- GET /trades?orderUid=… or ?owner=… (exactly one) for fills. [V: error text confirmed]
- GET /account/{owner}/orders (also 200 empty for unseen owner via /orders?owner returned empty) for the open list. [U for exact path]
- GET /users/{owner}/total_surplus works. [V]
- Fills can be partial when partiallyFillable true; executedBuyAmount rises per fill.

### A6. Fees, minimums, partial fills, expiry
- Fee: no fee up front for the person; surplus fee in sell token on fill (covers gas); protocol fee 2 bps on the quote (protocolFeeBps "2"); partner fee optional in appData (e.g. 25 or 70 bps by integrators). If we want revenue, it is an appData partnerFee with our recipient, which must be shown to the person. [V]
- Min size: no hard minimum, but API rejects below fee. Tests on WAVAX to USDC: 1e14 wei and 1e12 wei both returned SellAmountDoesNotCoverFee, fee about 0x3c6739e8db42d (about 0.0010 WAVAX, roughly $0.009) at 1e14. Practically a few dollars minimum so fee is not a large share. [V]
- Partial fills: partiallyFillable:true supported by protocol; default SDK false. A partly-fillable limit order can fill in pieces over days. [D/V SDK]
- Expiry: validTo uint32 unix seconds. SDK default 30 min for market (DEFAULT_QUOTE_VALIDITY); limit default in SDK is far-dated; MAX_VALID_TO_EPOCH in sdk-config. API max validity for limit orders: [U].
- Price oracle for "good price" guidance: GET /token/{addr}/native_price [V].

### A7. What the wallet flow must add (repo)
Today: `SigningPayload` (apps/dapp/lib/chains/types.ts:40) has an `evm` variant that is a transaction only (`to,data,value`); `signOn` in apps/dapp/lib/adapters/evm-adapter.ts:96 calls wagmi sendTransaction and returns `{family:'evm', hash}`. `SignedPayload` has no signature variant. Submit routes only expect hashes (`EVM_HASH` in send.ts etc.).
Needed:
1. New SigningPayload variant, e.g. `{family:'evm-typed', chainId, typedData:{domain,types,primaryType,message}, account}` and a SignedPayload `{family:'evm-typed', signature}`.
2. adapter: wagmi `signTypedData(wagmiConfig, {...})` after chain check; map user-rejection the same way.
3. Prepare step returns: approval tx (existing evm payload) then typed-data payload; the sequence engine (lib/chains/sequence-flow.ts) must allow a step whose result is a signature plus a server POST.
4. Submit route: server posts the order to CoW, computes UID and checks it matches; returns uid and an explorer link (https://explorer.cow.fi/avax/orders/{uid} [U]) instead of tx hash. SubmitResult's `hash` becomes an order id; a 'pending' outcome is natural.
5. Status route for open orders; a cancel flow (second typed-data sign for off-chain, or evm tx for invalidateOrder).
6. Native AVAX: wrap tx first (existing evm path), or eth-flow tx (existing path, value set).
7. SC wallets: not supported without EIP-1271/presign; detect via code at account and refuse, or use presign tx.

### A8. What `assertSafe` must verify before signing (server before showing, client again before sign)
Because the typed data comes from our server and the wallet shows the user raw hex, the check has to be done in our code, on the exact `message` to be signed:
- domain.name "Gnosis Protocol", version "v2", chainId 43114, verifyingContract exactly 0x9008D19f...ab41 (compared lowercase). A wrong verifyingContract makes the signature useless but a wrong chain could replay elsewhere.
- sellToken and buyToken equal the token addresses the user asked for (listed, never by symbol); sell is not equal to buy.
- receiver equals the signer account (or the explicit recipient the user typed). The zero address means "owner" in the protocol; refuse it anyway so what is shown matches.
- sellAmount and buyAmount: recompute from the user's stated amount and limit price in base units; buyAmount >= typed price x sellAmount for sell orders; for buy orders sellAmount <= the cap. Reject if it is better than the live native_price by an absurd margin (typo guard) and warn if the order would fill at once (market) or be 10x away.
- kind and partiallyFillable match the request.
- validTo: in the future, not more than the user's chosen expiry, not in the past, not uint32 max unless "no expiry" was chosen. Show it as a date.
- feeAmount "0".
- sellTokenBalance and buyTokenBalance both "erc20" (not "external"/"internal", which draw on Balancer vault balances).
- appData: hash matches the JSON we gave; JSON has no hooks (pre/post hooks run arbitrary calls from the settlement-time executor, a real risk, as the AAVE order above uses them) and only the partner fee we disclose.
- Approval tx: `to` is the sell token, selector approve(0x095ea7b3), spender exactly vault relayer 0xC92E...0110, amount equals sellAmount (not max), value 0. Wrap tx: to WAVAX with deposit() only. Eth-flow: to the eth-flow address, value equals sellAmount, receiver equals the owner.
- At submit: re-derive the order UID from the signed message and compare with what the API returned; check the returned owner equals the account.
- Wrong-chain protection: wallet chain 43114 before signing (the adapter already switches).

### A9. Risks and what a person can lose
- Order does not move funds until a solver fills at or above the limit; funds stay in the wallet (non-custodial). Loss exposure is the approved amount (use exact approvals; an unlimited approval stays open to the relayer for good).
- Stale limit: a resting order signs a price that holds until validTo. A big price move makes it fill at a price the person no longer wants (picking-off risk). Mitigate with short default expiry and a cancel button.
- Off-chain cancel is not instant: a fill in flight can still land. Use on-chain invalidate for certainty.
- AVAX gas dropping to zero leaves a person unable to approve/cancel; fills are paid by the solver out of the surplus fee.
- Thin Avalanche liquidity: 6 trades in about 30k blocks; limits may not fill and quote depth is limited.
- Phishing via malicious typed data (wrong spender or domain) is the main client-side risk; covered by A8.
- CoW is a hosted order book run by CoW DAO; if the API is down, the order stops being discoverable but it remains valid until validTo, and could still be settled if a solver has it; only on-chain invalidate reliably stops it.
- Native AVAX path via eth-flow: refund depends on invalidation (user or after expiry).

## B. Monad (chain 143)

### Verdict: NOT SAFELY BUILDABLE TODAY for a general limit order. Kuru is the only real candidate; a build is possible but I would not ship it without an audit and clearer admin facts.

### B1. CoW on Monad [V]
- https://api.cow.fi/monad/api/v1/version returns 404 (nginx). sdk-config 2.11.2 has no Monad chain (grep for 143 gave a block number only). docs list no Monad. GPv2Settlement code at 0x9008... exists on Monad RPC but CoW runs no API there; do not treat that as support. CoW: NOT SUPPORTED.
- 1inch, 0x, UniswapX, Bebop on Monad: web search found no evidence, [U]. Monday Trade (Uniswap v3-like AMM plus order book) exists [U], https://learn.backpack.exchange/articles/what-is-monday-trade ; not examined.

### B2. Kuru (best candidate) [D unless marked]
Docs reflect a new "Spot V2" system; the docs were last modified 2026-10-19 (sitemap) — about 17 days old. Old docs (llms.txt, /contracts/Audits, /contracts/Contract-addresses) now return 404 or list old architecture (MarginAccount/Router, "Audits: Spearbit, Cantina" in the stale llms.txt). Do not trust the old audit line for V2.
- Network: chain id 143 [V, eth_chainId 0x8f from rpc.monad.xyz].
- Contracts (https://docs.kuru.io/deployments/mainnet.md):
  - AccountCore proxy 0x264123a9B96Cc1193944cC25C188f1bD3dFa670e (custody, deposits)
  - SpotRouter proxy 0xBdDF3556701B7ECca5d69416CFfd7F86D37E52b3
  - WithdrawalLimiter proxy 0xF059F4AAb49Bd3AFB62134145EeAF38Fe103F0eA
  - ProtocolAuthority 0x15db88bAc73D856B3ca53683F82058826A3b6E8f; KeeperAuthority 0xbc36eC07800150489f9ED0f86a2d3E27Ca36980e
  - Nine OrderBook markets, e.g. MON/USDC 0xc9dE998e272d59a19CEA3783C8dd44f87A86405D, WETH/USDC 0x8121EE960066e4344A213F9aC7502395502aEe7a, cbBTC/USDC 0xAE8E0cf4A9ff696b5f6EC0B1339200EB4c09E422 (others in doc: XAUt0, NVDAx, SPYx, QQQx, TSLAx, EWYx).
  - USDC on Monad 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 [D, https://docs.monad.xyz/guides/kuru-flow].
- On-chain checks [V]: AccountCore, SpotRouter and markets are all 141-byte minimal proxies (ERC-1967 implementation slot style), so upgradeable. owner() of AccountCore, SpotRouter, ProtocolAuthority = 0x64b86d1d212357f7127d1e86740c897167bbf024, a 12 KB contract (not a Safe with getThreshold; type unknown, [U] whether timelock or multisig). KeeperAuthority owner 0x8b736dce... is a small contract (172 bytes). Market owner = SpotRouter.
- Flow:
  1. If ERC-20 sell: approve(AccountCore, amount) on the token. Native MON: deposit with value, token address(0).
  2. AccountCore.deposit(address rootOwner, address token, uint256 amount) payable (first deposit creates the root account, uint40 id; rootAccountIdOf(owner)).
  3. Market.batch(uint40 userId, (uint8 side, uint96 quantity, uint32 price, uint8 tif, uint8 executionInstruction, uint32 minSizeAfterBlock)[] orders, uint8[] cancelSlotIdxs) — owner sends the tx directly; our wallet path already supports this. Prices and sizes are in market precision; read getMarketParams() (pricePrecision, sizePrecision, tickSize) and make price % tick == 0.
  4. tif: GTC rests; IOC/FOK immediate. executionInstruction postOnly keeps it from crossing. Partial fills allowed; GTC remainder rests.
  5. Cancel: batch with cancelSlotIdxs, or cancelAllOrders(uint40 userId), by owner tx. Immediate and definitive when mined (on-chain book).
  6. Withdraw: AccountCore.withdraw(uint40 rootAccountId, address token, uint256 amount, address recipient). Free (non-reserved) funds only.
  7. Read: getMarketParams, order state events (BookUpdatesPacked, TradesPacked), REST https://api.mainnet.kuru.io (data source), gateway https://gateway.mainnet.kuru.io (needs wallet signature + JWT, [U] details). Docs say direct reads of balances/orders are via those APIs; exact endpoints [U].
- Fees [D]: maker 1 bp, taker 2 bps at base tier, tiers lower with 14-day volume; GTC post-only keeps a person as maker; resting bids reserve quote plus maker fee. Builder fee optional (needs account approval, approveBuilder).
- Minimums [D]: market-specific minQuoteNotional for GTC (value not published; read on-chain, [U]); maxQuoteNotional applies; tiny resting orders are cancelled as dust.
- Self-custody caveat: funds sit inside AccountCore (Kuru's contract) while an order is open; withdrawal passes a WithdrawalLimiter: bucket $200,000 shared across all users, refill about $8,333/hour, so a rush of withdrawals can be throttled; governance can change limits; docs mention freezes and a protocol pause with no stated controller (https://docs.kuru.io/accounts/withdrawal-availability.md).
- Audit status [U/negative]: no audit report found for V2 (AccountCore, SpotRouter). Cantina bounty (https://cantina.xyz/bounties/f93c6818-141e-43a0-941f-5f56d606ad6f) started 2025-11-24, max $50k, currently paused, scope not visible. DefiLlama TVL for Kuru CLOB was about $544k when searched (https://defillama.com/protocol/kuru-clob). Thin TVL and fresh upgradeable contracts with an unknown owner.
- SDK: @toxicflow-labs/ts-sdk (docs example) — an unusual package name, I did not inspect it, [U] whether Kuru-official. Do not take a dependency on it; we can ABI-encode batch ourselves.
- One-click trading / 7702 / relay features exist; we would not use them (they add signers and 7702 delegation).

### B3. What a build would need (if later chosen)
Tx-only, no typed data: approve to AccountCore, deposit, batch, later cancelAllOrders and withdraw: five tx types, all already expressible as `{family:'evm'}`. assertSafe: every tx to a fixed allowlist (AccountCore, one market, token), selector allowlist (approve, deposit, batch, cancelAllOrders, withdraw), approve spender = AccountCore exact amount, withdraw recipient = signer, the batch userId must equal the account's own rootAccountIdOf read on chain, side/price/quantity re-derived from the request and tick-checked, tif GTC with postOnly where the person asked for a resting order. State reading needs the Kuru API or an event indexer.

### B4. Risks / what a person can lose
- Custody in an upgradeable, unaudited-as-far-as-found contract: the whole deposit (not only the order) is exposed to a bug, a malicious upgrade, or a pause/freeze while funds are inside.
- Withdrawal limiter can delay exits in a stress event.
- Thin liquidity on most markets; rebase/price manipulation on small books; a resting order can be picked off (like any CLOB).
- Tokenised-stock markets (NVDAx, TSLAx, SPYx...) add issuer and off-hours risk; we would only offer MON/USDC, WETH/USDC, cbBTC/USDC at most.
- Prices and size use raw precision: wrong scale means an order at a price off by powers of ten (a fat-finger class loss); must be derived and checked from getMarketParams.

## Summary table
| Chain | Verdict | Biggest risk |
|---|---|---|
| Avalanche (CoW) | Buildable | needs typed-data signing in wallet flow; thin fills; stale-price exposure (funds never leave wallet) |
| Monad (Kuru) | Not recommended now | deposit goes into an upgradeable contract with no found audit, fresh V2, withdrawal throttle |
| Monad (CoW) | Not supported | API 404 |

## Sources
- https://docs.cow.fi/cow-protocol/reference/contracts/core
- https://docs.cow.fi/cow-protocol/reference/contracts/periphery/eth-flow
- https://api.cow.fi/avalanche/api/v1 (live calls: version, quote, orders, native_price, app_data, total_surplus, trades error)
- npm @cowprotocol/sdk-config 2.11.2, @cowprotocol/sdk-contracts-ts 4.0.1, @cowprotocol/sdk-trading 2.8.1, @cowprotocol/cow-sdk 9.3.3
- https://docs.kuru.io/deployments/mainnet.md, /contracts/order-book.md, /contracts/account-core.md, /matching-engine/order-types.md, /matching-engine/fees.md, /sdk/orders-and-cancellation.md, /accounts/withdrawal-availability.md, /accounts/one-click-trading.md, /api/introduction.md, https://docs.kuru.io/sitemap.xml
- https://cantina.xyz/bounties/f93c6818-141e-43a0-941f-5f56d606ad6f
- https://docs.monad.xyz/guides/kuru-flow
- Repo: apps/dapp/lib/chains/types.ts, apps/dapp/lib/adapters/evm-adapter.ts
