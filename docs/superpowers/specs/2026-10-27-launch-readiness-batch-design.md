# Launch-readiness batch: new integrations + reliability hardening

Design doc for [Issue #146](https://github.com/Cookit-labs/Intent/issues/146). Eight items, researched and specced together, to be implemented as one PR.

## Status

| #   | Item                           | Status                                                                                     |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Phoenix swap source            | Design ready                                                                               |
| 2   | Second lending venue (Templar) | **Dropped** — Templar is a NEAR Protocol lending protocol, not deployed on Stellar/Soroban |
| 3   | Hardware wallet (Ledger)       | Design ready — **blocked on a real-hardware spike** before implementation (see below)      |
| 4   | Agent audit trail              | Design ready — proceeds with the existing wallet-scoped trust model, no new access gate    |
| 5   | Spend-limit confirmation       | Design ready                                                                               |
| 6   | Rate limiting                  | Design ready                                                                               |
| 7   | Error-recovery UX              | Design ready                                                                               |
| 8   | Agent-health monitoring        | Design ready                                                                               |

## Decisions made before implementation

- **Hardware wallet (#3):** research found the Ledger module defaults to blind-hash signing, and no one has confirmed a real Ledger device can render this app's Soroban swap calls for review. Decision: spike with real hardware first. This item does not land in the implementation PR until that spike confirms it's safe to ship (forced non-blind signing + a device that can actually show the user what they're signing).
- **Agent audit trail privacy (#4):** the new history endpoint lets anyone who knows a wallet's public address read that wallet's past agent-reasoning text. Decision: ship as designed — this matches the trust model every other wallet-scoped endpoint in the app already uses (naira orders, swap history). No new proof-of-wallet-control gate.

---

---

# Integrating Phoenix as a swap quote source

Status: design only, no implementation code written. Everything marked
"verified" below was confirmed live against mainnet Soroban RPC
(`https://mainnet.sorobanrpc.com`) on 2026-10-27, via a throwaway script using
this repo's own `@stellar/stellar-sdk` dependency (`rpc.Server`,
`Contract.call`, `simulateTransaction`, `scValToNative`) — the same simulation
technique `aquarius-quoter.ts` and `soroswap-quoter.ts` already use. The
script was deleted after use; nothing was committed to the dapp's source tree.

Source consulted: `github.com/Phoenix-Protocol-Group/phoenix-contracts`, `main`
branch, read via the GitHub raw-content and REST API (unauthenticated) on
2026-10-27.

---

## 1. Mainnet contract addresses

**Verified live.** Found in `scripts/upgrade_mainnet.sh` in the Phoenix repo —
not in a README or a docs site; Phoenix does not publish a
`mainnet.contracts.json` the way Soroswap and Aquarius do. The script hardcodes
the addresses it upgrades, which makes it a deployment record rather than
documentation, but it is the only address source in the repo and it checked
out:

```
FACTORY_ADDRESS   = CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI
MULTIHOP_ADDRESS  = CCLZRD4E72T7JCZCN3P7KNPYNXFYKQCL64ECLX7WP5GNVYPYJGU2IO2G
```

Verification performed:

- Simulated `factory.get_config()` against `FACTORY_ADDRESS` on mainnet. It
  returned a real config object, including `multihop_address` —
  and that value was byte-for-byte `CCLZRD4E72T7JCZCN3P7KNPYNXFYKQCL64ECLX7WP5GNVYPYJGU2IO2G`,
  the same constant the upgrade script hardcodes. The factory and multihop
  addresses corroborate each other independently of the script, which is
  stronger evidence than the script alone.
- Simulated `factory.query_pools()`. It returned **13** live pool addresses.
  The upgrade script lists only **11** — two pools exist today that the script
  predates. This matters operationally: **the script's pool list must never be
  treated as authoritative or exhaustive.** `query_pools()` on the live factory
  is the only correct source of pool addresses, same as this app already does
  for Aquarius via `get_pools`.
- Simulated `pool.query_config()` on one of those 13 pools
  (`CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX`) and got back a
  config with `token_a` = the mainnet XLM SAC and `token_b` = the mainnet
  Circle USDC SAC (both derived locally via `Asset.native().contractId()` /
  `new Asset('USDC', <Circle issuer>).contractId()` against the mainnet
  passphrase, and confirmed matching) — so this is the XLM/USDC pool.
- Simulated `pool.simulate_swap(offer_asset=XLM, offer_amount=100 XLM)` on that
  pool and got a real priced answer: `ask_amount` 166043384 (~16.6 USDC, in
  USDC's base units), `commission_amount` 834388, `spread_amount` 1586303,
  `total_return` 168464075.
- Simulated `factory.query_for_pool_by_token_pair` with the pair in **both**
  orderings (XLM,USDC and USDC,XLM) and got the identical pool address back
  both times. See the sorting gotcha in §3 — this is the opposite of Aquarius.
- Did **not** get a successful `multihop.simulate_swap()` call — the throwaway
  script's manual `ScMapEntry` encoding for the `Swap` struct argument was
  wrong (`a.key is not a function`), and I did not fix it before concluding
  the investigation, because per-pool `simulate_swap`/`swap` alone is
  everything a direct-pool quoter in this codebase's style needs (that is
  exactly the shape Aquarius's quoter uses — it talks to the router per-pool,
  not through a meta-aggregation hop). **Open risk:** the multihop contract's
  live interface for `simulate_swap` is not independently confirmed by
  simulation, only by reading its source. If multi-hop routing through
  non-direct pairs is wanted later, that call needs to be gotten working and
  verified before being trusted.

Testnet address: **not found and not verified.** The repo's deploy scripts
(`scripts/deploy.sh`, `scripts/deploy_pool.sh`) deploy fresh contracts rather
than referencing a standing testnet instance, and no testnet factory/multihop
constant appears anywhere in the repo. If testnet support is wanted, Phoenix
would need to be asked directly or a fresh instance deployed for this app's
own testing — there is nothing to point `lazyId`'s `testnet` field at today.
This is a real gap: every other source in `contract-registry.ts` has a
testnet id, and Phoenix would be the first that does not (`noetherMarket`/
`noetherRouter` have `mainnet: undefined`, the mirror image of this case).

## 2. The router's quoting interface

Phoenix is **not a single router with a pool-index scheme** like Aquarius.
It is a three-contract system:

- **Factory** (`CB4SV…`) — creates and looks up pools. Pools are addressed by
  their own contract id, discovered via the factory, not via an index into one
  router contract.
- **Multihop** (`CCLZR…`) — a thin orchestrator that takes a `Vec<Swap>` of
  hops, asks the factory for each hop's pool address, and calls that pool's
  own `swap`/`simulate_swap` in sequence. It holds no liquidity and knows no
  prices itself; every number it returns is `simulate_swap`'s answer, chained.
- **Pool** (one contract per pair, e.g. `CBHCR…` for XLM/USDC) — the actual AMM.
  This is where `swap` and `simulate_swap` live, and where the real price
  comes from.

For a direct single-hop quote (which is all this app's Aquarius and Soroswap
quoters do today), the natural pattern is: **ask the factory for the pool,
then call that pool's `simulate_swap` directly** — skip multihop entirely for
one hop, the same way `aquarius-quoter.ts` calls the router's `estimate_swap`
directly rather than going through some meta-contract.

### Factory (`factory_contract::FactoryTrait`), relevant subset

```rust
fn query_pools(env: Env) -> Vec<Address>;
fn query_pool_details(env: Env, pool_address: Address) -> LiquidityPoolInfo;
fn query_for_pool_by_token_pair(env: Env, token_a: Address, token_b: Address) -> Address;
fn query_pool_by_pair_type(env: Env, token_a: Address, token_b: Address, pool_type: PoolType) -> Address;
```

`query_for_pool_by_token_pair` is read-only, takes no `pool_type`, and —
**verified live** — resolves correctly in either argument order. Internally
it tries `(a,b)` then `(b,a)` against its storage key before giving up (read
from `contracts/factory/src/contract.rs`, confirmed live above). This is the
function to use for an XYK pool lookup; `query_pool_by_pair_type` is its
type-aware sibling for Stable/Blended pools and isn't needed unless this
integration ever needs non-XYK pools.

### Pool (`pool::LiquidityPoolTrait`), relevant subset — this is what actually prices a swap

```rust
fn simulate_swap(env: Env, offer_asset: Address, sell_amount: i128) -> SimulateSwapResponse;
fn simulate_reverse_swap(env: Env, ask_asset: Address, ask_amount: i128) -> SimulateReverseSwapResponse;
fn swap(
    env: Env,
    sender: Address,
    offer_asset: Address,
    offer_amount: i128,
    ask_asset_min_amount: Option<i128>,
    max_spread_bps: Option<i64>,
    deadline: Option<u64>,
    max_allowed_fee_bps: Option<i64>,
) -> i128;
fn query_config(env: Env) -> Config;  // { token_a, token_b, share_token, ... }
```

`SimulateSwapResponse` (pool-level, `contracts/pool/src/storage.rs`) — **this
exact shape was returned by the live call above**:

```rust
pub struct SimulateSwapResponse {
    pub ask_amount: i128,
    pub commission_amount: i128,
    pub spread_amount: i128,
    pub total_return: i128,
}
```

Note this is a _different type_ from the multihop-level
`SimulateSwapResponse` in `contracts/multihop/src/storage.rs`, which wraps
`commission_amounts`/`spread_amount` as `Vec<(String, i128)>` /`Vec<i128>`
across however many hops were chained, plus a top-level `ask_amount`. Reading
the pool's answer directly is simpler and is the one actually exercised live.

`sender.require_auth()` is implied by `swap` taking a `sender` — the builder
will need to pass the signer's own address there, the same recipient-pinning
concern Aquarius's `assertSelfAquariusSwap` exists for (§3).

### Multihop — present for completeness, not verified live, probably unneeded for v1

```rust
fn simulate_swap(env: Env, operations: Vec<Swap>, amount: i128, pool_type: PoolType) -> SimulateSwapResponse;
fn swap(env: Env, recipient: Address, operations: Vec<Swap>, max_spread_bps: Option<i64>,
        amount: i128, pool_type: PoolType, deadline: Option<u64>, max_allowed_fee_bps: Option<i64>);
```

```rust
pub struct Swap {
    pub ask_asset: Address,
    pub offer_asset: Address,
    pub ask_asset_min_amount: Option<i128>,
}
```

`pool_type` here is a _single_ enum value applied to every hop in `operations`
— the Rust source confirms it resolves each hop's pool via
`query_for_pool_by_token_pair` (Xyk) or `query_pool_by_pair_type`
(Stable/Blend) using that one pool_type, so a multihop route can't mix an XYK
hop with a Stable hop in one call. Irrelevant for a direct quoter; relevant
only if this integration later adds routed, multi-hop Phoenix quotes.

## 3. Gotchas — verified, not guessed

- **Token-pair ordering does NOT matter for lookup**, unlike Aquarius. The
  factory's `query_for_pool_by_token_pair` tries both `(a,b)` and `(b,a)`
  internally (confirmed by reading `contracts/factory/src/contract.rs`, and
  by live-simulating the call both ways and getting the identical pool
  address). **Do not port Aquarius's `sortedPair` helper to Phoenix** — it is
  unnecessary complexity that would do nothing, and worse, could mask a real
  bug if some other Phoenix call _does_ care about order (not observed, but
  not exhaustively tested either — the `swap`/`simulate_swap` calls themselves
  take a single `offer_asset` address, not a pair vector, so there is no
  "pair order" concept at that layer regardless).

- **Amounts are `i128`, matching Soroswap, not Aquarius's `u128`.** Every
  amount argument in the pool and multihop interfaces (`sell_amount`,
  `ask_amount`, `offer_amount`, `amount` in `Swap`) is typed `i128` in the
  Rust source. This was exercised live: `nativeToScVal(100_0000000n, { type:
'i128' })` against `pool.simulate_swap` worked and returned a real quote.

- **Pools are addressed by their own contract id, not an index.** There is no
  Aquarius-style `pool_index: BytesN<32>` concept anywhere in Phoenix. A quote
  from this source should carry the **pool's contract address** (not a
  `SwapQuote.poolIndex`, which is documented in `quote.ts` specifically as "a
  hex-encoded 32-byte index" — Phoenix's pool address is a `C...` strkey, a
  different shape entirely). This needs either a new field on `SwapQuote` or
  overloading `poolIndex` to carry a strkey instead of hex bytes, which would
  be a misnomer. See §4/§5 open risk.

- **One pair can have exactly one XYK pool today** (verified: `query_pools()`
  returned 13 total pools across all pairs; `query_for_pool_by_token_pair`
  returned a single address for XLM/USDC, not several). Unlike Aquarius's
  three-pools-per-pair design, Phoenix's factory model appears to be
  one-pool-per-(pair,type) via its V2 storage key — `query_pool_by_pair_type`
  reads a `(pool_type, a, b)` slot, implying at most one pool per pool_type
  per pair, though Stable or Blend variants of the _same_ pair would be a
  second, differently-typed pool. Not fully proven by exhaustive search; only
  checked for the one pair queried.

- **The live pool count is 13, not the 11 the mainnet upgrade script
  hardcodes.** Confirms that script is a point-in-time deployment record, not
  a maintained manifest — `query_pools()` must be the runtime source of pool
  addresses, exactly as this app already treats Aquarius's `get_pools` as the
  source of pool addresses rather than a constant.

- **No testnet address found anywhere in the repo.** See §1. This source may
  need to launch mainnet-only, same shape as `noetherMarket`/`noetherRouter`
  having `mainnet: undefined` today, just the opposite asymmetry.

- **No public quote API, confirmed by the repo's own absence of one.** Same
  situation as Soroswap and Aquarius — simulation against the live contract is
  the only way to price a Phoenix swap. Nothing like Soroswap's documented-but-
  404ing `/quote` endpoint even exists to rule out here; Phoenix simply never
  claimed to have one.

- **Multihop's `simulate_swap` was not successfully called live in this
  investigation** (encoding bug in the throwaway script, not a contract
  problem as far as could be determined by reading the source). Anyone
  implementing multihop support must get a real simulated call working and
  verify the response shape before trusting the Rust source alone — this
  repo's own stated standard, per the Aquarius header comment, is simulating
  each path before writing code against it, not reading a spec and assuming.

## 4. Proposed file structure

Two new files, following the exact pattern of `aquarius-quoter.ts` /
`build-aquarius.ts`:

### `lib/swap/sources/phoenix-quoter.ts`

- `createPhoenixQuoter(options)` returning a `QuoteSource` with `id: 'phoenix'`.
- Resolves `fromContract`/`toContract` via `sacFor` (same as Aquarius/Soroswap)
  — Phoenix pools are addressed by Soroban contract token, same SAC-based
  asset model as the other two Soroban sources, not something new.
- `quote()`/`quoteAll()`:
  1. Simulate `factory.query_for_pool_by_token_pair(fromContract, toContract)`.
     A `LiquidityPoolNotFound` panic (surfaced as a simulation error) means
     `no_route`, same as Aquarius treats "no pool" as an ordinary outcome, not
     a fault.
  2. Simulate `pool.simulate_swap(fromContract, sendAmount)` on the resolved
     pool address, amount as `i128`.
  3. Build a `SwapQuote` with `destAmount` = the response's `total_return`
     (not `ask_amount` — `total_return` is what the trader actually nets;
     `ask_amount` appears to be the pre-fee or gross figure based on the field
     names, though this needs confirming against the Rust pool math before
     shipping, since the live response had `ask_amount` 166043384 vs.
     `total_return` 168464075 — the larger number — which is backwards from
     what "ask after commission" would suggest and needs resolving, not
     assumed either way).
  4. Carry the resolved **pool address** on the quote (new field — see §5)
     so the builder executes the exact pool that was priced, matching why
     Aquarius's `poolIndex` exists at all.
- Only `strict_send` supported initially, matching Aquarius and Soroswap — no
  evidence yet of how `simulate_reverse_swap` behaves live.
- Header comment should state plainly, in this codebase's documented style,
  which claims here are "verified by simulating the live mainnet contract on
  [date]" versus "read from source, not yet exercised live" — multihop in
  particular falls in the second bucket and must say so.

### `lib/swap/build-phoenix.ts`

- `buildPhoenixSwap(options)` mirroring `buildAquariusSwap`: loads the Horizon
  sequence number, builds a single `invokeHostFunction` operation calling the
  resolved pool contract's `swap`, with `sender` = the account (recipient
  pinning, same concern as Aquarius).
- `assertSelfPhoenixSwap(built, account)` mirroring `assertSelfAquariusSwap`:
  decode the built XDR, refuse anything but a lone `swap` call, refuse unless
  argument 0 (`sender`) equals the signing account. Argument count for `swap`
  is 7 (`sender, offer_asset, offer_amount, ask_asset_min_amount,
max_spread_bps, deadline, max_allowed_fee_bps`) — confirm this against a
  real built transaction before hardcoding the count the way Aquarius's
  assertion hardcodes 7 for its own, different, 7-argument shape (coincidence
  of arg count, not shared structure — don't let that similarity suggest the
  two are more alike than they are).
- No pool-index bytes to validate (Phoenix has none); instead this builder
  should assert the pool address being called is the one the quote named, the
  same spirit as Aquarius pinning the pool index, adapted to Phoenix's
  addressing scheme.

## 5. Changes to `contract-registry.ts` and `venue-routing.ts`

### `contract-registry.ts`

- Add `phoenixFactory` and `phoenixMultihop` via `lazyId`, mainnet values from
  §1, `testnet: undefined` reversed from the pattern — actually `testnet`
  can't be `undefined` per `lazyId`'s type signature (`ids: { testnet: string;
mainnet: M }` — testnet is required, non-optional). This means either:
  - a new `lazyId`-like helper that allows an optional testnet too, or
  - a real testnet deployment gets stood up for Phoenix before this ships, or
  - testnet support for Phoenix is simply not attempted and the quoter's
    `isConfigured()` is hardcoded to require `activeNetwork() === 'mainnet'`.
    This is a real wiring question the implementer needs to resolve, not
    something to paper over — flagged again in §6.
- **Phoenix's per-pool addressing means the registry cannot pre-list specific
  pool contract ids the way Aquarius's single router id works.** The allowlist
  in `candidates()` is keyed by a closed, enumerable set of contract ids
  (`soroswapRouter()`, `aquariusRouter()`, etc.) — but Phoenix's tradeable
  pools are a runtime-discovered, currently-13-and-growing set of addresses.
  `lookupContract`/`labelForCall` need either:
  - a registry entry for the **factory** (so `query_pools`/`query_for_pool_by_token_pair`-type
    reads are clearly Phoenix, though these are read-only simulations and
    arguably never reach the allowlist at all since nothing signs a read), and
  - a _dynamic_ membership check for pool addresses — e.g. "is this contract
    id currently one of Phoenix's `query_pools()` results" — rather than a
    static map entry, since a static list would drift the moment Phoenix adds
    pool #14.
    This is a structural mismatch with how the registry currently works and is
    the single biggest open design question for this integration (see §6).

### `venue-routing.ts`

- Add `'phoenix'` to `VenueKind` alongside `'classic' | 'soroban' | 'aquarius' | 'aggregator'`.
- Add a `case 'phoenix': return 'phoenix'` arm in `builderFor`.
- Add a `case phoenixPoolAddress: assertSelfPhoenixSwap(...)` style branch in
  `assertSelfSubmission` — but this is where the dynamic-pool-set problem
  bites hardest: the existing `switch (contractId)` in `assertSelfSubmission`
  matches against a small number of _known, static_ router/aggregator
  constants. Phoenix calls will be against one of 13-and-growing _pool_
  addresses, not one static router id. This switch needs to become "is this
  the known static Phoenix factory, or one of the addresses the quote itself
  already named as the pool it priced" rather than a hardcoded case label —
  which changes the shape of this function's logic, not just adds a line.

### `quote.ts`

- Add `'phoenix'` to `QuoteSourceId` and `SOURCE_DISPLAY_NAMES`.
- `SwapQuote` needs a way to carry the resolved pool contract address. Options:
  - a new optional field, e.g. `poolAddress?: string`, distinct from the
    existing `poolIndex?: string` (which is explicitly documented as "a
    hex-encoded 32-byte index" — a Phoenix pool address is a `C...` strkey and
    does not fit that shape or its doc comment without being misleading).
  - This is additive and low-risk, but it's a new concept the type doesn't
    have yet and should be named and documented as carefully as `poolIndex`
    was.

### `venues.ts`

- Add a `phoenix` venue descriptor entry alongside `aquarius`/`soroswap`,
  `networks: ['mainnet']` only (pending §1's testnet gap), `category: 'swap'`.

## 6. Open risks / unknowns implementation must resolve

1. **No testnet deployment is known to exist.** Either stand one up, find one
   that already exists (ask Phoenix directly — not found by reading the repo),
   or ship mainnet-only and accept the asymmetry with every other source in
   `contract-registry.ts`, which currently all have both ids (Noether is
   mainnet-`undefined`, the mirror case, but nothing today is testnet-only-
   impossible).
2. **The registry's static-allowlist model doesn't fit a growing, runtime-
   discovered pool set.** This is the architectural question, not a detail —
   see §5. Needs a decision before any code is written: does
   `assertSelfSubmission`/`lookupContract` grow a "query the live factory"
   escape hatch, or does the quoter's own `quote()` call double as the
   allowlist by having the builder refuse to sign any pool address that
   wasn't the one just priced (which the quote already carries) — the latter
   seems more consistent with how `poolIndex` already works for Aquarius
   (the quote names the exact thing that may be executed, and the builder
   trusts nothing it re-derives) and avoids needing the registry to track
   pool membership at all. This recommendation should be confirmed with
   whoever owns `contract-registry.ts`'s design intent before implementing.
3. **`ask_amount` vs `total_return` semantics are not confirmed.** The pool
   simulation returned `ask_amount: 166043384` and `total_return: 168464075`
   for the same call — `total_return` is the larger number, which is
   counterintuitive if commission is subtracted from a gross `ask_amount`.
   Whichever field becomes `SwapQuote.destAmount` must be the one that matches
   what the live `swap()` call actually delivers, confirmed by executing (or
   very carefully reading the pool's swap math in `contracts/pool/src/contract.rs`),
   not guessed from field names.
4. **Multihop's live interface is unconfirmed.** If multi-hop Phoenix routes
   are ever wanted (e.g. pairs with no direct pool), `multihop.simulate_swap`
   needs a working, verified live call — not just the Rust source reading —
   before any code trusts its response shape.
5. **Pool-per-type uniqueness is not exhaustively verified.** Only one pair
   (XLM/USDC) was checked for "exactly one pool." Whether some pair has both
   an XYK and a Stable pool simultaneously (plausible given `pool_type` is a
   dimension of the lookup key) should be checked before assuming
   `query_for_pool_by_token_pair` alone (which is XYK-only per its doc comment
   in the Rust source) is a complete picture of Phoenix's liquidity for a pair.
6. **`PoolType` enum values beyond `Xyk` are unexplored.** `Stable` and
   `Blend` variants exist in the contract interfaces but were not queried live
   at all. If Phoenix's deepest liquidity for some pair is in a Stable pool,
   an XYK-only quoter would silently miss it — worth at least a `query_pools()`
   - `query_pool_details()` sweep to see what pool types actually exist on
     mainnet before deciding v1's scope.
7. **No contract spec/ABI (`.json`) was fetched from the chain itself** —
   everything above comes from reading Rust source and from the shapes that
   actually came back from simulation, not from a formally diffed contract
   spec. This matches how `aquarius-quoter.ts`'s header describes its own
   verification ("by reading its spec and simulating each pool"), but anyone
   implementing this should re-simulate against whatever pool/pair they
   actually ship against, not trust this document's one sampled pool as
   representative of all 13 (soon more).

## 7. Rough task breakdown

1. **Spike: get a real `swap()` built, signed (testnet or a disposable mainnet
   account with trivial amounts), and submitted end-to-end against one pool**,
   to settle open risk #3 (`ask_amount` vs `total_return`) and confirm the
   `swap` argument count/order used by `assertSelfPhoenixSwap`. Do this before
   writing the quoter, not after — this codebase's standard is simulate-and-
   verify before documenting a function as understood.
2. **Resolve the testnet question** (risk #1) — either locate/deploy a testnet
   instance or get sign-off to ship mainnet-only.
3. **Resolve the registry/allowlist shape question** (risk #2) with whoever
   owns `contract-registry.ts` — this changes the shape of
   `assertSelfSubmission`, not just adds an entry, and should be designed
   before `build-phoenix.ts` is written against an assumption that might not
   match.
4. Add `phoenixFactory`/`phoenixMultihop` (or just `phoenixFactory`, if
   multihop stays out of scope for v1) to `contract-registry.ts`.
5. Write `lib/swap/sources/phoenix-quoter.ts`: factory lookup +
   per-pool `simulate_swap`, `strict_send` only, following
   `aquarius-quoter.ts`'s structure (a `simulate()` helper, a `poolsOf`-style
   decoder if multiple pool types turn out to matter, explicit `no_route`
   vs `upstream_error` vs `timeout` failure handling).
6. Write `lib/swap/build-phoenix.ts`: `buildPhoenixSwap` +
   `assertSelfPhoenixSwap`, matching whatever the spike in task 1 confirmed
   about argument layout and recipient pinning.
7. Wire `venue-routing.ts` (`VenueKind`, `builderFor`, `assertSelfSubmission`),
   `quote.ts` (`QuoteSourceId`, `SOURCE_DISPLAY_NAMES`, the new pool-address
   field on `SwapQuote`), and `venues.ts` (venue descriptor).
8. Add Phoenix to wherever `createAquariusQuoter`/`createSoroswapQuoter` are
   instantiated and assembled into the active source list (not read in this
   investigation — locate the call site, likely near where `activeSources` is
   consumed, before wiring).
9. Tests: at minimum, a test using an injected `serverImpl` (matching
   `AquariusQuoterOptions.serverImpl`'s pattern) to check `no_route` handling,
   pool resolution, and the destAmount field choice from task 1/risk #3 —
   without hitting the network on every test run.
10. Re-verify live once more immediately before merging — contract addresses,
    pool count, and the chosen response field — since this document's
    verification has a timestamp and Phoenix's pool set has already been
    observed to grow since its own upgrade script was last touched.

---

# Templar Verification Spike — Verdict

## VERDICT: VERIFIED BUT NOT YET INTEGRABLE (wrong architecture for this app)

Templar Protocol is a real, live project with real TVL — it is not vaporware and not a marketing-copy error. But it is **not a Soroban/Stellar-native lending contract**. It is a NEAR Protocol lending protocol that accepts Stellar-held XLM as cross-chain collateral through NEAR's Chain Signatures / MPC / Intents infrastructure. There is no Soroban contract this app could call the way it calls Blend's pool, and no documented public REST API for building Stellar-side transactions the way DeFindex's API does. Integrating it today would mean integrating NEAR Intents and a third-party MPC bridge, not "another lending venue on Stellar."

**Recommendation: drop Templar from the launch-readiness scope.** Re-evaluate only if Templar ships a native Soroban vault/market contract with its own address, or publishes a documented Stellar-specific API — neither of which exists today as far as this research could confirm.

---

## 1. What was found

### Templar is real and live

- Official site: [templarfi.org](https://templarfi.org) — "the first Cypher Lending Protocol," focused on borrowing dollars against Bitcoin, with a $4M pre-seed raise announced. Links to `app.templarfi.org` (Launch App), `docs.templarfi.org` (Docs), and `github.com/Templar-Protocol`.
- Stellar launch announced via Templar's own account: [Templar Protocol on X, Nov 5 2025](https://x.com/TemplarProtocol/status/1986105736712339799) — "Templar, the first Cypher Lending Protocol, is launching on @StellarOrg... Stellar users can now deposit XLM to borrow USDC on Stellar!"
- Third-party coverage confirms the same launch: [cryptonews.net](https://cryptonews.net/news/blockchain/31941317/), [Bitget](https://www.bitget.com/news/detail/12560605052841), [Phemex](https://phemex.com/news/article/stellar-users-gain-direct-usdc-borrowing-via-templar-protocol-34343), [Lumexo blog](https://blog.lumexo.io/templar-protocol-stellar-launch-cypher-lending/).
- Listed on [DeFiLlama](https://defillama.com/protocol/templar-protocol) with real TVL. Figures vary by snapshot: ~$13–22M total TVL across chains, with a Stellar-attributed slice reported between ~$2M and ~$4.9M depending on source/date. DeFiLlama's own protocol JSON (`api.llama.fi/protocol/templar-protocol`) lists Stellar only inside the asset-origin `chains` array, not as a `chainTvls` entry with its own address — consistent with Stellar being a collateral-source chain, not a deployment chain.
- Has a professional audit: [Halborn — Templar Protocol Smart Contract Assessment](https://www.halborn.com/audits/templar-protocol/smart-contract-assessment-0669c5) (full report content didn't load via fetch, but its existence and title confirm a real audited codebase, not a stub project).
- Research overview referenced by a Llama-affiliated researcher: [Templar Protocol Overview, Jun 3 2026 (PDF)](https://artifacts.llama.fi/chat-uploads/00193900-7155-43c8-bbdf-a3a6b48c8337.pdf) — describes Templar's TVL, risk rating ("High"), and architecture in more depth than official docs do.

### The architecture: NEAR-native, not Soroban-native

- GitHub: [github.com/Templar-Protocol/contracts](https://github.com/Templar-Protocol/contracts) — repo topics are `near-protocol`, `near-intents`; Rust/Cargo layout typical of NEAR contracts. README does not name Stellar or Soroban anywhere.
- DeFiLlama's own protocol metadata sets Templar's primary `chain` field to **`"Near"`**. Other chains (Bitcoin, Stellar, Ethereum, Solana, etc.) are collateral-origin chains tracked via Pikespeak indexer data, not separate Templar deployments.
- Official docs guide ([docs.templarfi.org/guide/](https://docs.templarfi.org/guide/)) states directly: _"Collateral held on other chains (Bitcoin, Ethereum, Stellar, XRP, Solana, and more) reaches NEAR through [NEAR Intents]."_ There is no mention of a Soroban or Stellar-native smart contract that a user (or an integrator) calls directly.
- The same docs page describes **"curated vaults on Stellar"** that "route depositor liquidity into markets," with links to a "Stellar Curated Vaults" page and a "Stellar Vault Curator Guide" — but the actual contract/vault details weren't retrievable through this research pass (pages either 404'd or weren't reachable via WebFetch).
- A third-party research note (unverified, flagged explicitly as such by the researcher) describes the real mechanism as: a **HOT Bridge** running MPC nodes inside TEEs custodies XLM deposited on Stellar and mints a wrapped representation on NEAR; NEAR Intents then handles settlement via competing solvers. That note also flags an **unfixed vulnerability** in the MPC node database (ciphertext swapping) and says there is **no dedicated audit for the bridge itself** and **no liveness guarantee**. This directly contradicts Templar's "no bridging, no wrapping" marketing language — a real discrepancy worth flagging, not resolved by this research.
- Halborn's audited scope appears (per earlier indirect references, not independently confirmed from the full report) to cover a "Templar Soroban Vault" — but the official June 2026 project overview says a Soroban-native vault layer is still "on the roadmap," not shipped. Sources disagree on whether a native Soroban contract exists today; this research could not resolve the conflict, which itself argues against treating Templar as integrable right now.

### No usable integration surface found

- No Stellar/Soroban contract address was found anywhere (not on the official site, not in docs, not in the GitHub repo structure, not in DeFiLlama's JSON, which explicitly has `address: null`).
- Docs mention an **"API Reference"** covering "the backend HTTP API, generated Rust API documentation, and the gateway method catalog" — but the actual endpoint path(s) could not be located (`docs.templarfi.org/api/` 404'd; no OpenAPI spec or endpoint list surfaced via search). This is the same shape of documentation DeFindex has, but unlike DeFindex, no working base URL or endpoint catalog could be confirmed live.
- No evidence of position/health-factor/rate query endpoints usable by a third party. The closest thing documented is a "live risk dashboard" for humans, not an API for integrators.
- `app.templarfi.org` returned only a page title ("Templar Protocol - Cypher Lending") with no visible wallet-connection or Stellar-wallet (Freighter/Lobstr) references in the fetched content — consistent with a functioning SPA whose content requires JS execution to inspect further, but not something this research could positively confirm as Stellar-wallet-integrated from the outside.

### Sanity check: is "Templar" actually something else?

No — it is clearly the same project Stellar's marketing page referenced ("Borrow stablecoins against XLM without selling it," "USDC borrowing markets" matches Templar's own Nov 2025 announcement almost verbatim). It is not confused with "Templar DAO" (a separate, unrelated BSC protocol-owned-liquidity project found in search noise) or the historical Knights Templar (also surfaced as search noise for the bare name). The Stellar marketing page is accurate about Templar's existence and user-facing claim; it just omits (as marketing pages do) that the plumbing underneath is a NEAR protocol with Stellar as a bridged collateral source, not a Soroban dApp.

---

## 2. Why this doesn't get a design doc

The existing lending venues in this codebase (`apps/dapp/lib/lend/blend-client.ts`, `apps/dapp/lib/lend/defindex/`) share one property Templar currently lacks: a **verifiable, directly-callable integration surface on Stellar** — either a known Soroban contract address (Blend) or a documented, reachable REST API with a stable base URL (DeFindex, `api.defindex.io`). Templar has:

- No confirmed Soroban contract address.
- No confirmed reachable API base URL or endpoint catalog (docs reference one but it wasn't locatable).
- An architecture that routes Stellar deposits through NEAR Intents and (per unverified third-party research) an MPC bridge with an open, unpatched vulnerability and no bridge-specific audit.
- Internal disagreement across sources about whether a native Soroban vault exists yet or is still roadmap.

Building `lib/lend/templar/` today would mean one of:

1. Integrating NEAR Intents/Chain Signatures directly (a completely different trust and transaction model than every other venue in this app, and not something `blend-client.ts`/DeFindex patterns extend to), or
2. Calling an API whose existence is documented but whose endpoints could not be confirmed live, against a bridge component with a reported open vulnerability.

Neither is a responsible scope for a swap-routing dapp to take on as a third lending venue right now, and doing so would require re-deriving this entire investigation's open questions (bridge security, actual API shape, whether a Soroban vault ships) as implementation blockers rather than spike questions.

## 3. Recommendation

- **Drop Templar from the launch-readiness issue scope**, as the task instructions anticipated.
- If Templar later ships a confirmed native Soroban market/vault contract (resolving the Halborn-audit-vs-roadmap conflict in favor of "shipped"), or publishes a working, documented Stellar-specific API with a stable base URL, this spike should be re-run rather than assumed stale — the project is actively building (per its own roadmap language and the June 2026 third-party overview), so this could change within months.
- Worth a one-line note wherever Blend/DeFindex are listed as "the two venues we integrate": Templar was investigated and rejected for lacking a Stellar-native integration surface, not for being fake — so it isn't silently re-proposed by someone re-reading the Stellar marketing page.

---

# Ledger hardware-wallet support for Intent (Stellar dapp)

Status: design draft. Primary finding is a **blocking correctness/safety gap**, not just missing wiring — see §2 and §6.

## 0. Sources checked

- `apps/dapp/lib/stellar-kit.ts` — kit init, explicit module list, comment calling out that hardware-wallet/WalletConnect modules were skipped for bundle size.
- `apps/dapp/lib/adapters/stellar-adapter.ts` — the only place `signTransaction`/`getNetwork` are called against the kit; has prior wallet-specific handling for Lobstr connection keys.
- `apps/dapp/lib/chain-adapter.ts` — abstract `ChainAdapter`/`SignRequest`/`SignOutcome` interface the Stellar adapter implements. Wallet-agnostic; nothing here needs to change for Ledger.
- `apps/dapp/lib/wallet/lobstr.ts` — pattern for wallet-specific quirks, used as the template below.
- `@creit.tech/stellar-wallets-kit@2.6.0` (resolved under `node_modules/.pnpm/@creit.tech+stellar-wallets-kit@2.6.0_.../node_modules/@creit.tech/stellar-wallets-kit`), specifically:
  - `esm/sdk/modules/ledger.module.js` / `.d.ts`
  - `esm/sdk/kit.js` (how `StellarWalletsKit.signTransaction`/`getNetwork` delegate to the selected module)
  - `package.json` dependencies: `@ledgerhq/hw-app-str@7.2.8`, `@ledgerhq/hw-transport@6.31.12`, `@ledgerhq/hw-transport-webusb@6.29.12`
- `@ledgerhq/hw-app-str@7.2.8` source (`src/Str.ts`) — the actual APDU-level instructions the Ledger Stellar app firmware exposes.
- App-side Soroban usage: `apps/dapp/lib/swap/build-soroban.ts`, `lib/server/execution-flow.ts`, and all `signTransaction` callers (`hooks/use-swap-execution.ts`, `use-swap.ts`, `use-perp.ts`, etc.) — confirms the app only ever signs a complete prepared transaction envelope; it never calls `signAuthEntry` directly from the client.
- No `stellar-adapter.test.*` or similar exists in the repo (checked via glob); no wallet-picker component tests found beyond `components/layout/connect-wallet.tsx` (not wallet-specific, kit-driven UI) and e2e specs under `apps/dapp/e2e/` (none reference Ledger/hardware wallets).

---

## 1. What the integration actually requires

Not quite "just add an import." It's small, but there are three real changes, plus one thing that must NOT be added without further work (see §2):

1. **`stellar-kit.ts`**: import `LedgerModule` from `@creit.tech/stellar-wallets-kit/modules/ledger` and push `new LedgerModule()` into the `modules` array. Mechanically identical to the existing six.
2. **Buffer polyfill — real requirement, not optional.** The module's own doc comment says: _"This module requires that you have a 'Buffer' polyfill in your app, if not provided then this module will break your app."_ `ledger.module.js` imports `Buffer`-consuming APIs (`encodeBase64`, `Transaction.addSignature`, the `@ledgerhq/hw-app-str` wire protocol) that assume Node's `Buffer` global exists. Next.js (webpack 5 / Turbopack) does not polyfill `Buffer` in the browser by default. This needs:
   - a bundler-level polyfill (e.g. `buffer` npm package + a webpack `ProvidePlugin`, or whatever the project's existing Next.js config convention is for Node polyfills), verified to load before the Ledger module executes.
   - This should be scoped (webpack alias/fallback, not a global `window.Buffer = ...` hack) to avoid affecting bundle size/behavior for users who never touch Ledger.
3. **`stellar-adapter.ts` — `getNetwork()` cannot be trusted for Ledger.** `kit.js`'s `StellarWalletsKit.getNetwork()` just forwards to `selectedModule.getNetwork()`, and `LedgerModule.getNetwork()` unconditionally throws `{ code: -3, message: 'Ledger Wallets do not support the "getNetwork" function' }`. Three places in the adapter call this:
   - `alignKitNetwork()` is unaffected (it only _sets_ network, never reads).
   - the network-mismatch poll (`useStellarWallet`, around the `window.setInterval` block) calls `StellarWalletsKit.getNetwork()` inside a `try/catch` that silently does nothing on failure — today this is a benign "a wallet that cannot say leaves the last answer in place," but for Ledger it will _always_ throw, so `walletNetwork`/`isWrongNetwork` will never update from Ledger's actual state. Since Ledger has no software concept of "network" at all (it only knows the passphrase it's told at signing time), there is no wrong-network detection possible for Ledger — this needs to be surfaced as a known limitation (e.g. skip the poll / show "network not reported" messaging) rather than silently appearing as "correct network" by omission.
   - `signStellarTransaction()` also calls `StellarWalletsKit.getNetwork()` to pre-check network before signing, then falls back to `walletPassphrase = undefined` on throw, which trips `refusesToSign(undefined, ...)`. Need to confirm (read `wallet-network.ts`, not yet reviewed) whether `refusesToSign` treats `undefined` as "don't know, proceed" or "wrong/refuse" — this determines whether Ledger users can sign at all, or get hard-blocked by a network check that is unanswerable for hardware wallets. **This must be checked before shipping**, since Ledger's `signTransaction` call in the module itself takes `networkPassphrase` as an explicit _input_ and signs for whatever is passed — the adapter's own passphrase is always available and correct; the broken part is only the pre-check, not the actual signing network.
4. **Lobstr-style wallet quirks module.** Following the `lib/wallet/lobstr.ts` pattern, a `lib/wallet/ledger.ts` (or extending `stellar-adapter.ts` directly) should encapsulate: path selection (Ledger supports multiple derivation paths/addresses — `getAddresses(page)` — the current single-address flow via `getAddress()` works for the common case but offers no account picker UI), and the "Hash Signing not enabled" error (`StellarHashSigningNotEnabledError` in `@ledgerhq/hw-app-str`'s `errors` module) surfaced as an actionable message instead of a raw wallet error.
5. **Transport lifecycle.** `LedgerModule` keeps a single long-lived `_transport` (`TransportWebUSB.create()`), reused across calls, closed on `disconnect()`. If the browser tab loses the USB connection (device unplugged, re-plugged into a different port, OS permission revoked), subsequent calls will throw and the module does not auto-reconnect — `stellar-adapter.ts`'s wallet-error handling (the `walletErrorMessage`/reject-regex pattern) needs a Ledger-specific case added, since these errors won't match the "rejected/denied/declined/cancel/close" regex and will surface as raw `wallet_error` text from the Ledger/WebUSB stack (often cryptic, e.g. "Failed to execute 'transferIn' on 'USBDevice'").

So: real integration work is import + polyfill + network-check adjustment + error-message polish + (optionally) an account-picker UI for multiple Ledger addresses. Call it half a day to a day of implementation, not "one line," even before addressing §2.

---

## 2. Soroban / smart-contract signing support on Ledger — the critical finding

This is the part that actually gates shippability for a swap-routing app, and it is more nuanced than a flat "unsupported," so read carefully.

**The library-level API exists.** `@ledgerhq/hw-app-str@7.2.8`'s `Str` class defines three device instructions:

- `INS_SIGN_TX` (`0x04`) → `signTransaction(path, signatureBase)` — sends the transaction's **signature base** (the full structured XDR envelope that's hashed to produce the tx hash) to the device for **on-screen review and signing**, i.e. non-blind signing. This is the instruction that would, in principle, let the device parse and display an `InvokeHostFunction` operation if its firmware supports rendering Soroban ops.
- `INS_SIGN_SOROBAN_AUTHORIZATION` (`0x0a`) → `signSorobanAuthorization(path, hashIdPreimage)` — a **dedicated instruction for signing Soroban authorization entries** (the `HashIdPreimage` structure used for `SOROBAN_CREDENTIALS_ADDRESS` auth, as opposed to source-account auth). Its presence is a strong signal that Ledger's firmware team has specifically built Soroban-aware signing, not just "sign whatever bytes you're handed."
- `INS_SIGN_HASH` (`0x08`) → `signHash(path, hash)` — blind-signs a 32-byte hash with no on-device content review at all. This requires "Hash Signing" to be explicitly enabled in the Ledger Stellar app's settings (a user-facing toggle, off by default, precisely because blind-signing means the device shows the user nothing about what they're authorizing).

**What Intent's integration actually calls, today, if LedgerModule is added as-is:** `LedgerModule.signTransaction()` defaults to `str.signHash(path, tx.hash())` — **blind hash signing** — unless the caller passes `nonBlindTx: true`, which `stellar-adapter.ts`'s `StellarWalletsKit.signTransaction(req.xdr, { address, networkPassphrase })` call does **not** do. So out of the box, every Ledger signature in this app would be a blind hash signature: the user sees nothing about amounts, destinations, or contract calls on their device screen, and must have manually enabled a setting that most users leave off (and the app issues no detection/guidance for that state beyond whatever generic error the firmware returns).

**This matters more for Intent than for a payment app** because:

- Intent's swaps are Soroban `InvokeHostFunction` calls (`lib/swap/build-soroban.ts`), not classic `Payment`/`PathPaymentStrictSend` ops. Blind-signing a swap means the user's only protection against a malicious or buggy server-built transaction is trusting the dapp completely — exactly the trust hardware wallets exist to remove.
- Even non-blind (`nonBlindTx: true`, i.e. `str.signTransaction`), what matters is whether the **on-device firmware** can actually decode and render an `InvokeHostFunction` operation's contents (contract address, function, args) in a human-readable way, versus falling back to some generic "complex operation, unable to display, proceed blindly?" screen. That is a firmware/app capability question this investigation could not verify directly (it requires either the physical device + current Ledger Stellar app, or Ledger's own release notes/changelog for the Stellar app — not npm package changelogs) but the presence of `INS_SIGN_SOROBAN_AUTHORIZATION` as a distinct, purpose-built instruction strongly suggests **recent (2024+) Ledger Stellar app versions have added explicit Soroban awareness**, which historically (pre-2024) Stellar's Ledger app did not have — the operation would previously either fail to parse or require blind-hash signing with no way to verify what's being signed.
- The app never calls `signAuthEntry`/`signSorobanAuthorization` from the client today (confirmed by grep — no `signAuthEntry`/`authorizeEntry` call sites in client-side hooks). This is actually good news: self-invoked Soroban auth (source-account credentials) is signed as part of the main transaction signature, not as a separate client-side auth-entry signature, so Intent likely does **not** need Ledger's `signAuthEntry`/`signSorobanAuthorization` path at all for its current swap flow — _unless_ a future flow needs delegated/address-based Soroban auth (e.g. a relayer signing on behalf of another address), which would hit `LedgerModule.signAuthEntry()`, which **unconditionally throws** `'Ledger Wallets do not support the "signAuthEntry" function'` in this kit version (2.6.0) regardless of the underlying `hw-app-str` capability — the kit simply hasn't wired that device instruction through yet.

**Net assessment:**
| Capability | Status |
|---|---|
| Ledger JS library exposes a Soroban-specific signing instruction (`signSorobanAuthorization`) | Yes, present in `hw-app-str@7.2.8` |
| `stellar-wallets-kit@2.6.0`'s `LedgerModule` wires that instruction through (`signAuthEntry`) | **No — hardcoded to throw** |
| Intent's current flow needs `signAuthEntry` at all | Apparently no (source-account auth only, signed inline with the tx) |
| Default signing mode for a full transaction via this kit | **Blind hash signing** (`signHash`), unless `nonBlindTx: true` is explicitly passed |
| Whether Ledger's on-device Stellar app firmware can render `InvokeHostFunction` details for non-blind review | **Unverified** — needs physical device testing or Ledger's own Stellar-app release notes; this report's library-level evidence (dedicated Soroban APDU) is suggestive but not confirmation |

**Recommendation:** treat this as **not safely shippable as a drop-in module addition**. At minimum, before shipping Ledger support for a _swap_ flow specifically (as opposed to e.g. a simple "send XLM" feature, which would classic-sign cleanly either way):

1. Force `nonBlindTx: true` on every Ledger `signTransaction` call from this app (never default to blind hash signing for a contract-invoking swap) — this needs a kit-level or adapter-level override, since the kit's default omits it.
2. Physically test with current-generation Ledger hardware + current Ledger Stellar app firmware that an actual Intent swap transaction either (a) renders comprehensibly on-device, or (b) is rejected/falls back cleanly rather than silently blind-signing.
3. If the device cannot render Soroban ops comprehensibly, consider gating Ledger support to only the non-swap, classic-operation flows in the app (if any exist) until Ledger's firmware catches up, rather than exposing it for swaps.

---

## 3. Browser compatibility (WebUSB/WebHID)

- `LedgerModule` uses `@ledgerhq/hw-transport-webusb`, i.e. the **WebUSB** API (not WebHID). `TransportWebUSB.isSupported()` gates both `isAvailable()` and `runChecks()` in the module, and `getAddress`/`signTransaction` both call `runChecks()` first, throwing `"Ledger wallets can not be used"` if WebUSB isn't supported.
- **WebUSB browser support**: Chrome, Edge, Opera, and other Chromium-based browsers (desktop only). **Not supported in Safari or Firefox**, and not available on iOS at all (no browser on iOS exposes WebUSB/WebHID regardless of engine, due to Apple's WebKit restrictions). This is a materially different compatibility story than every other module already in `stellar-kit.ts` (Freighter/xBull/Rabet are extensions that work in any browser that supports extensions; Lobstr/Albedo/Hana have their own compatibility models but none are WebUSB-gated).
- **HTTPS requirement**: WebUSB requires a secure context (HTTPS or localhost). Already true for this app in production; worth confirming local dev (`next dev`) over `http://localhost` still works (it should — `localhost` counts as a secure context for this API) but noting it since it's a new constraint class for this codebase.
- **UI messaging needed**: the wallet picker modal is rendered by the kit itself (`StellarWalletsKit.authModal()` → preact `SwkApp` component), not by Intent's own `connect-wallet.tsx`. The kit's `refreshSupportedWallets()` already calls each module's `isAvailable()` to flag unavailable wallets in its own UI (used for the "needs installing" labels), so **Ledger appearing grayed-out/flagged in Safari or Firefox should happen automatically** via the kit's existing mechanism — no new UI code needed for the base case. What _would_ need custom messaging is a clearer-than-default explanation (the kit's generic "not available" treatment may just look like "not installed," which is misleading for a browser-capability issue rather than a missing-extension issue) — consider a tooltip/note specifically for Ledger along the lines of "Ledger requires Chrome, Edge, or another Chromium browser" rather than relying on the kit's generic unavailable state.
- **SSR**: no new SSR concern beyond what already exists. `ensureKit()` in `stellar-kit.ts` already guards on `typeof window === 'undefined'`, and the Ledger module's WebUSB calls only ever run from client-triggered handlers (`connect()`, `signTransaction()`), same as every other module.
- **No WebHID path**: this kit version uses WebUSB specifically. Not a concern itself, just worth noting if anyone searches for WebHID-specific permission UI (chrome's device-chooser permission prompt) — same user-facing permission dialog pattern applies for WebUSB.

---

## 4. Known rough edges (from module source + library structure; no live changelog/issue-tracker access available in this environment)

Since this environment couldn't reach GitHub issues/CHANGELOG for `@creit.tech/stellar-wallets-kit` directly, these are rough edges identified from reading the shipped source itself — treat as "found in code," not "confirmed via maintainer changelog," and verify against the actual GitHub repo (`Creit-Tech/Stellar-Wallets-Kit`) before finalizing:

- `getNetwork()` throws unconditionally for Ledger (§1.3) — a structural gap in the kit's abstraction, not a bug per se, but it means any app written against the kit's common interface (assuming every module can answer "what network am I on") breaks for Ledger specifically.
- `signAuthEntry()` and `signMessage()` both throw unconditionally (`code: -3`) for Ledger, despite the underlying `hw-app-str` package having a real `signSorobanAuthorization` instruction the kit doesn't expose. This looks like the kit's Ledger integration lagging behind the capability of its own dependency — worth filing/checking upstream for a fix rather than assuming it'll never land.
- Single active transport instance with no reconnect/retry logic (§1.5) — device unplug/replug mid-session requires a full `disconnect()`/reconnect by the user, with whatever generic error message WebUSB/the transport layer produces bubbling straight to the UI.
- No account-picker UX wired into the adapter — `getAddresses(page)` exists in the module (fetches 10 addresses per page) but nothing in `stellar-adapter.ts` or the kit's own modal (as far as reviewed) surfaces a path/account selector; the default flow uses whatever `mnemonicPath` state happens to be set, implying first-use defaults to account index 0 unless the dApp explicitly manages this.
- Default signing mode is blind (§2) — this is the single rough edge with real financial-safety consequences for a swap app and should be the top implementation priority, not treated as a cosmetic gap.

---

## 5. Task breakdown for implementation

1. **Spike: verify on real hardware.** Before writing any app code, get a Ledger device + current Stellar app, build one real Intent swap transaction (via the existing server-side builder in `lib/swap/build-soroban.ts`), and manually drive it through `LedgerModule.signTransaction(xdr, { nonBlindTx: true, address, networkPassphrase })` in isolation (a throwaway script/page is fine) to see what actually renders on the device screen. This answers §2's open question and should gate everything after it.
2. **Bundler polyfill.** Add a `Buffer` polyfill scoped to not bloat the main bundle (dynamic import / separate chunk for the Ledger module path, consistent with the existing "each module is a separate bundle" comment in `stellar-kit.ts`).
3. **`stellar-kit.ts`**: import and register `LedgerModule`.
4. **Force non-blind signing for Ledger specifically.** In `signStellarTransaction()` (`stellar-adapter.ts`), detect the selected module is Ledger (`StellarWalletsKit.selectedModule.productId === 'LEDGER'`, matching the existing Lobstr `productId === 'lobstr'` pattern) and pass `nonBlindTx: true` through the sign call. Confirm the kit's `signTransaction` passthrough (`kit.js`) actually forwards an options bag with `nonBlindTx` — it currently spreads `opts` through, so this should work without a kit patch.
5. **Network-check handling for Ledger.** Decide and implement: either skip the wrong-network poll entirely for Ledger (can't be answered) and show a persistent "network isn't reported by this wallet — the transaction is still built for \[current network]" notice, or confirm `refusesToSign(undefined, ...)` (in `lib/wallet-network.ts`, not yet read in this investigation — **read this before implementing**) doesn't hard-block Ledger users from ever signing.
6. **Error messaging.** Extend `walletErrorMessage` (`lib/wallet/error-message.ts`, referenced but not read in this investigation) or add a Ledger-specific branch in `signStellarTransaction` for: `StellarHashSigningNotEnabledError`-shaped errors (tell the user to enable Hash Signing in the Ledger Stellar app settings, if blind-signing is kept as a fallback) and raw WebUSB transport errors (device unplugged, permission denied, wrong app open on device).
7. **Browser-capability messaging in the picker.** Verify the kit's own `isAvailable()`-driven unavailable-state styling is clear enough for Ledger in Safari/Firefox; add a short explanatory tooltip/copy if the generic treatment reads as "not installed" instead of "not supported in this browser."
8. **Account/path selection (optional for v1).** Decide whether first-release Ledger support restricts to account index 0 (simplest, matches most users' actual setup) or needs a picker using `getAddresses()`. Recommend deferring this to a fast-follow unless user research says otherwise.
9. **Manual QA pass**, not automated — no existing `stellar-adapter.test.*` exists to extend, and WebUSB cannot be exercised in headless CI/e2e without hardware or a mocked transport. If test coverage is wanted, the realistic option is unit-testing the adapter's Ledger-specific _branches_ (productId detection, nonBlindTx flag, error-message mapping) with a mocked `StellarWalletsKit`/`selectedModule`, not an end-to-end signing test.
10. **Docs/support copy.** User-facing note that Ledger requires Chrome/Edge/Chromium, a physical device, the Stellar app installed and open, and (if blind-signing fallback is kept) Hash Signing enabled.

---

## 6. Open risks

1. **(Critical, blocking)** Whether current Ledger Stellar-app firmware can render Soroban `InvokeHostFunction` details on-device for non-blind signing is unverified from this codebase/package investigation alone — it requires physical hardware testing or direct confirmation from Ledger's own Stellar-app documentation/changelog (not reachable from this environment). If it cannot render Soroban ops, shipping Ledger for swaps means shipping blind-signing for a contract-invoking flow, which undermines the entire value proposition of a hardware wallet (verifiable signing) and arguably should not ship until resolved.
2. The kit's `signAuthEntry`/`signSorobanAuthorization` gap (throws unconditionally despite the underlying library supporting it) means any future flow requiring delegated Soroban authorization (not just source-account auth) cannot use Ledger through this kit version without an upstream fix or a local patch/fork of the kit's Ledger module.
3. No existing automated test coverage for the wallet-adapter layer at all (`stellar-adapter.test.*` does not exist) — Ledger-specific logic added here would be the first wallet-adapter code with no regression safety net unless tests are added alongside it.
4. WebUSB device-permission UX (Chrome's device picker) is a one-time-per-origin grant that can be revoked by the user/OS outside the app's control, and the module has no reconnect/retry affordance — expect support burden from "it worked yesterday, now it doesn't" reports.
5. This investigation could not reach the live GitHub issue tracker or changelog for `@creit.tech/stellar-wallets-kit` (no web access in this run) — §4's "rough edges" are inferred from source reading only. Before implementation, someone should actually check `https://github.com/Creit-Tech/Stellar-Wallets-Kit` issues/releases for Ledger-specific bug reports or fixes landed after version 2.6.0.
6. Multi-account/path handling defaults to whichever `mnemonicPath` happens to be set in the kit's shared state; in a multi-tab or multi-session scenario this global, module-level state (mirrors the kind of shared-state footgun already called out for Lobstr's per-tab connection key) could cause a Ledger sign request to silently target the wrong derivation path if not carefully scoped — worth a specific look during implementation, not just at design time.

---

# Agent decision audit trail — design

## 1. Current-state gap analysis

Three gaps, read directly from the code:

**(a) The winning agent's reasoning is stripped before it ever reaches storage — and the strip happens earlier than it looks.**

`lib/agents/brain.ts`'s `AgentProposalResult` carries `reasoning: string` ("one or two sentences, shown in the competition panel"). It is live in the browser today: `components/intents/competition-panel.tsx:216` renders `proposal?.reasoning` directly in the agent's bubble. But in `app/api/agents/compete/route.ts`, the `attempts.push(...)` call that builds the analytics record (lines 369–376) never reads `proposal.reasoning` at all:

```ts
attempts.push({
  agent: agent.key,
  model: agent.model,
  ok: true,
  latencyMs: Date.now() - began,
  routeId: proposal.routeId,
  executionMode: proposal.executionMode,
})
```

So the stripping documented in `analytics.ts`'s module comment ("They hold no emails and no text anyone typed or any model wrote") is enforced twice over: once by `RaceAttemptOk` not having a field for it, and again by `raceRecordFrom()` only ever reading fields `RaceAttemptOk`/`RaceAttemptFailed` already have. By the time a race reaches Postgres, the reasoning is gone — not redacted, never captured.

**(b) Races are not linked to a wallet address.**

`agent_races` has no account/wallet column, and nothing in `compete/route.ts`'s request body carries a wallet address — the POST body is `{ text, chain, context, reading }` only. The wallet is not known at race time; it is known later, when the user executes the winning proposal and calls a submit route, which calls `logExecution()` with an `account`.

The link that already exists runs the other direction: `usage_executions.race_id` is populated by a correlated subquery in `recordExecution()` (`analytics.ts:290-296`) that matches the `x-intent-race` header's UUID against `agent_races` where `winner IS NOT NULL` and the execution landed within 30 minutes of the race starting. So **a wallet is already joinable to a race today**, via `usage_executions.race_id = agent_races.id`, for races that were actually acted on. There is no reverse row on `agent_races` itself, and no join for races that were run but never executed (no proposal picked, or the user closed the tab) — those stay wallet-less by design, because no wallet ever touched them.

**(c) No user-facing page reviews past races.**

`app/[chain]/history/page.tsx` exists and shows `OpenPositions`, `SwapHistory`, `IntentActivity` for the connected wallet — all either on-chain reads or the app's own record of _executions_. Nothing on it, or anywhere else in `app/`, lists races themselves (won or not) with the reasoning behind the winning pick. `app/[chain]/agents/[id]/page.tsx` is an unrelated "Slice 2" preview (a per-agent reputation chart), not a per-wallet race history.

The only existing reader of race data is `lib/server/admin-metrics.ts` → `app/api/admin/metrics/route.ts`, gated by `isAdminRequest()`, and it reports aggregates (win rates, latency percentiles, failure reasons) — never a specific race's content, and never scoped to one wallet.

---

## 2. Proposed schema change

**Add one column to `agent_proposals`, not a new table, and not a column on `agent_races`.**

```sql
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS reasoning TEXT;
```

Reasoning is per-proposal already (`agent_proposals` has one row per agent per race), so it is the natural home — no new join, no new primary key shape. The column stays `NULL` for every losing proposal: only the row where `won = true` ever gets it written. This is enforced in `raceRecordFrom()` (a function, not a convention a caller could forget), the same place that currently enforces "no reasoning, from anyone" — see §6 for the exact change.

Why not a new table: a race-reasoning table keyed on `race_id` alone would just be `agent_proposals` with the losing rows deleted; reusing the existing row avoids a second place that can disagree with `won`.

Why not a column on `agent_races`: the winner's agent key is already there (`agent_races.winner`), and `agent_proposals` is already keyed on `(race_id, agent)` — looking up the winning row is `agent_proposals WHERE race_id = $1 AND won = true`, which the admin-metrics queries already do the equivalent of (`JOIN agent_proposals p ... WHERE p.won`).

**No new column for the wallet link.** The existing `usage_executions.race_id → agent_races.id` relationship (§1b) already answers "which races did this wallet trigger" for every race that led to a signed transaction — which is every race worth showing a user, since a race nobody acted on has no outcome to review. The history endpoint (§3) reads:

```sql
SELECT r.*, p.reasoning
FROM usage_executions e
JOIN agent_races r ON r.id = e.race_id
JOIN agent_proposals p ON p.race_id = r.id AND p.won = true
WHERE e.account = $1 AND e.network = $2
ORDER BY e.submitted_at DESC
```

This also means a race is only ever shown once it is tied to a wallet by way of a real execution — so there is no window where an unlinked, walletless race could be mis-joined to the wrong account. The existing 30-minute matching window (`analytics.ts:293-296`) is the only place that decides the link, and it is unchanged by this feature.

One edge case this surfaces: if a user runs a race, lets it pick a winner, and executes a _different_ agent's proposal than the winner (`competition-panel.tsx` lets the user pick any revealed card, not just the crowned one — "You pick who executes"), the stored reasoning is still the **race's winner's** reasoning, not the proposal the user actually signed. This matches what is scored and labeled "Recommended" today, and is called out explicitly in the UI copy (§4) rather than silently showing the wrong agent's words.

Migration file: add the `ALTER TABLE` line to `packages/db/migrations/007_analytics.sql`, matching the existing note in `analytics.ts` ("Keep packages/db/migrations/007_analytics.sql in sync") — or the next-numbered migration file if `007` has already shipped to production, per standard migration discipline.

---

## 3. API: `GET /api/agents/history`

```
GET /api/agents/history?address=<G...>&network=<mainnet|testnet>&page=<n>
```

**Request**

| param     | required | notes                                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `address` | yes      | a valid Stellar `G...` public key (`StrKey.isValidEd25519PublicKey`, same check `naira/orders/route.ts` uses) |
| `network` | no       | defaults to `activeNetwork()`; must be `mainnet` or `testnet`                                                 |
| `page`    | no       | defaults to `1`; fixed page size, matching admin-metrics' `PAGE = 25` convention                              |

**Response**

```jsonc
{
  "address": "GABC...",
  "network": "mainnet",
  "page": 1,
  "pageSize": 25,
  "total": 13,
  "races": [
    {
      "raceId": "f2b1...",
      "startedAt": "2026-10-20T14:03:11.000Z",
      "intentType": "swap",
      "tokenIn": "XLM",
      "tokenOut": "USDC",
      "sizeUsd": 42.5,
      "agentsAsked": 4,
      "agentsAnswered": 3,
      "winner": "deepseek:deepseek-chat",
      "unanimous": false,
      "winningReasoning": "Resting at 0.1142 clears the book's ask with room, and the agent that filled now would have eaten 0.4% of slippage for no reason to hurry.",
      "executedAgent": "deepseek:deepseek-chat",
      "matchesWinner": true,
      "executionHash": "a1b2c3...",
      "explorerUrl": "https://stellar.expert/explorer/public/tx/a1b2c3...",
    },
  ],
}
```

- `winningReasoning` is `null` when the race had no winner (`outcome != 'winner'`) or reasoning was never captured for it (races recorded before this change shipped).
- `executedAgent` / `matchesWinner` surface the edge case from §2: if the user executed a proposal other than the crowned winner, the UI can say so plainly instead of implying the shown reasoning belongs to what was signed.
- No per-losing-agent detail is returned — by design (§4 of the privacy section and §1a: losing reasoning is never stored, so there is nothing to leak even if the shape wanted it).

**Implementation shape**, following `admin-metrics.ts`'s repository pattern exactly (a `HistoryRepo` with one method, built over the shared `QueryFn`, with a bound query timeout):

```ts
// lib/server/agent-history.ts
export interface RaceHistoryRow {
  raceId: string
  startedAt: string
  intentType: string
  tokenIn: string
  tokenOut: string
  sizeUsd: number | null
  agentsAsked: number
  agentsAnswered: number
  winner: string | null
  unanimous: boolean | null
  winningReasoning: string | null
  executedAgent: string | null // read off the winning route's agent key when distinguishable, else same as winner
  matchesWinner: boolean
  executionHash: string | null
}

export interface HistoryRepo {
  racesForWallet: (
    account: string,
    scope: { network: StellarNetworkName },
    page: { limit: number; offset: number }
  ) => Promise<{ total: number; rows: RaceHistoryRow[] }>
}
```

The route handler (`app/api/agents/history/route.ts`) mirrors `admin/metrics/route.ts`'s GET shape minus the admin gate, plus the address validation naira/orders already does:

```ts
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams
  const address = params.get('address')
  if (address === null || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: 'invalid_address' }, { status: 400 })
  }
  const network = params.get('network') ?? activeNetwork()
  if (!isNetwork(network)) return NextResponse.json({ error: 'invalid_network' }, { status: 400 })
  const page = Math.max(Number(params.get('page')) || 1, 1)

  const repo = await getHistoryRepo().catch(() => undefined)
  if (repo === undefined) return NextResponse.json({ error: 'no_database' }, { status: 503 })

  const { total, rows } = await repo.racesForWallet(
    address,
    { network },
    { limit: PAGE, offset: (page - 1) * PAGE }
  )
  return NextResponse.json({ address, network, page, pageSize: PAGE, total, races: rows })
}
```

No `POST`, no mutation — read-only, matching the admin-metrics precedent exactly. `Cache-Control: no-store`, same reasoning as admin-metrics (a wallet's history should never show a stale page after a new trade).

---

## 4. UI placement

**Extend `app/[chain]/history/page.tsx`, not a new page.**

The page already lists, top to bottom: `OpenPositions` (live), `SwapHistory` (settled, on-chain + app record), `IntentActivity`. A new `AgentDecisions` (or similarly named) section slots in after `SwapHistory`: it is a _reason for_ a swap that already appears above it, not a new category of thing the user has to learn to find. Concretely:

- Each row in `SwapHistory` that has a `raceId` (it already carries `bundledWith`/`bundleSteps` joined on from the app's own record — the same pattern) could instead show an inline "Why this route" disclosure directly on the swap row, reusing the existing expand/collapse affordance in `SwapRow` (`components/intents/swap-history.tsx:213-379`) rather than adding a whole separate list the user has to cross-reference by time and token pair.
- The simplest version that ships first: a small link/button inside the already-expanded `SwapRow` detail panel ("Why the agent picked this ↗") that fetches `/api/agents/history?address=...` filtered client-side to the matching `raceId`, and shows the winning agent's name, model, and `winningReasoning` in a short block styled like the `agentBubble` used in `competition-panel.tsx` — same visual language the user already saw live during the race, so the history view reads as "the same bubble, later" rather than a new UI pattern.
- If product wants a dedicated browsable list (not just inline-per-swap), add it as a second tab/section titled "Agent decisions" on the same History page, independent of `SwapHistory`'s grouping — never a new top-level nav item, since Intent's nav is chain-scoped sections (`app/[chain]/...`) and this is a variant of history, not a new product surface.

Either way: **same page, same wallet gate** (`useWallet().isConnected`), no new route segment, no new nav entry.

---

## 5. Privacy / scoping design

**Confirmed: a user must only ever see their own race history, by wallet address, never a global listing.**

- The endpoint takes `address` as a _required_, validated parameter — there is no "list all races" mode (contrast `naira/orders`' GET, which defaults to the session's own email when no `account` is given; this endpoint has no session concept at all to default to, so address is mandatory, not optional-with-fallback).
- The query is always `WHERE e.account = $1 AND e.network = $2` against `usage_executions` — a wallet can only see races that its own `account` executed against. There is no code path that accepts a race id directly and looks it up without the address filter; a race id is never itself a bearer token for its own content.
- Reasoning text is never returned for any agent except the race's winner (§2: the column is only populated for `won = true` rows, so there is no losing-agent prose in the database to accidentally serialize even if a future bug loosened the query).
- No email/session gate, matching how the rest of swap execution works today (wallet-only, no login) — but this does mean **anyone who knows a wallet's public address can read that wallet's race history**, same as they can already read `SwapHistory`'s ledger data (public by nature of Stellar) and the same as `usage_executions.account` is queried unauthenticated-by-session elsewhere in this codebase. This is consistent with the existing trust model (a Stellar address is public; the app does not treat knowing one as authentication) but is worth a product decision check: if reasoning text is considered more sensitive than "this wallet swapped X for Y," gate the endpoint behind proof of wallet control (a signed challenge) before shipping — nothing in the current codebase does this for any wallet-scoped endpoint, so adding it here would be a new pattern, not an extension of one.
- Unlike `naira/orders`, there is no cross-email leakage risk to design around, because there is no email dimension here at all — the entire scoping question collapses to "does `address` match `usage_executions.account`," which is a single indexed equality check (`usage_executions_account_idx` already exists, `analytics.ts:45`).

---

## 6. Data retention

**No existing retention or cleanup job was found.** Grepping `analytics.ts` and the repo for cron/cleanup/TTL logic over `agent_races`, `agent_proposals`, or `usage_executions` turns up nothing: these are explicitly described as "two small append-only logs... written as things happen and never changed," with no deletion path. `admin-metrics.ts`'s `RANGES` (`7d | 30d | 90d | all`) is a _query_ window, not a retention policy — `all` reads every row ever written.

Storing reasoning text changes this calculus somewhat: it is the first free-text, model-authored content these tables would hold (previously everything was enums, numbers, and fixed codes — the module comment's "no text anyone typed or any model wrote" invariant). Two options, to raise as a product decision rather than assume:

1. **Match existing policy exactly**: keep it forever, same as every other column. Simplest, consistent, and the reasoning is already a sanitized 1-2 sentence summary the user saw live — it is not raw model output or a chain-of-thought dump.
2. **Add a retention window specific to this column only** (e.g. null it out via a scheduled job after 90 days), if the team wants free text to have a shorter shelf life than structured analytics. This would be new infrastructure — there is no cron/job runner referenced anywhere in `lib/server/`, so it would need one introduced, which is a materially bigger lift than the rest of this feature.

Recommendation: ship with option 1 (no special retention) to match the codebase's existing stance, and revisit only if a privacy review specifically flags stored model prose as different in kind from the numeric fields beside it.

---

## 7. Task breakdown

1. **Schema**: add `reasoning TEXT` to `agent_proposals` in `ANALYTICS_DDL` (`lib/server/analytics.ts`) and the matching line in `packages/db/migrations/007_analytics.sql` (or next migration number).
2. **Types**: add `reasoning?: string` to `RaceAttemptOk` in `analytics.ts`, and `reasoning: string | null` to the winning entry in `RaceRecord['proposals']`. Update `raceRecordFrom()` so only the proposal where `a.agent === input.winner` carries reasoning through — every other proposal's reasoning (even if accidentally passed in) is dropped, enforced in code, not by caller discipline.
3. **Wire-up**: in `app/api/agents/compete/route.ts`, add `reasoning: proposal.reasoning` to the `attempts.push({...})` call for successful proposals (line ~369). No wallet plumbing needed here — §2 established the wallet link is derived later via `usage_executions.race_id`, not carried through the race record itself.
4. **Repo layer**: add `lib/server/agent-history.ts` with `HistoryRepo`/`createHistoryRepo`/`getHistoryRepo`, following `admin-metrics.ts`'s `createMetricsRepo`/`getMetricsRepo` pattern (shared pool, bound query timeout, schema-ensured via the existing `getAnalyticsRepo()` call since no new table is introduced).
5. **Route**: add `app/api/agents/history/route.ts` (GET only), per §3.
6. **UI**: extend `components/intents/swap-history.tsx`'s `SwapRow` detail panel with the "why this route" disclosure (§4), fetching the history endpoint scoped to the connected wallet and the row's known `raceId` (swap rows likely need `raceId` threaded through from wherever `SwapRecord` is built — check `lib/swap/history.ts` for whether `race_id` already rides along via the `usage_executions` row it reads, since that column already exists per `analytics.ts:50`).
7. **Admin-metrics parity check (optional, not required for this feature)**: `admin-metrics.ts`'s `agents()` method already reports aggregate win rates; no change needed there, since admin metrics intentionally stays aggregate-only and should not start surfacing individual reasoning text to admins any more than to the public endpoint without a separate decision.
8. **Privacy sign-off**: resolve the open question in §5 (public-by-address vs. wallet-proof-gated) before shipping to mainnet, since it is a product/security call this doc cannot make unilaterally.

---

# Spend-limit confirmation for large swaps

## Why

The wallet's own signature prompt is the real authorization boundary — it
always has been, and this design does not touch that. What it is missing is
a moment, _before_ the wallet is even asked, where a fat-fingered amount or a
bad agent plan gets one more look from a human who is about to move real
money. Today a $5 swap and a $5,000 swap reach `Sign & swap` through the
identical screen. That is correct for the $5 swap and wrong for the $5,000
one: nothing on `SwapConfirm` forces a second look proportional to the size
of the mistake it would catch.

This is a UX safety net, not a security control. It is sized, worded, and
placed to interrupt autopilot thumbs on genuinely large trades, and to never
be felt on the small, frequent ones that are this app's normal traffic.

## Prior art already in this codebase

Two things already exist that this design builds on rather than invents:

- **`MAINNET_MAX_TRADE_USD` (`lib/server/trade-cap.ts`, default `$500`)** is
  a _hard, server-enforced_ per-trade cap on mainnet only. It throws
  `TradeCapExceeded` and the trade cannot be built at all above the cap. This
  is a different feature with a coincidentally identical default: a safety
  rail for an app that hasn't earned trust with volume yet, not a
  confirmation step. **Do not reuse this constant or its env var** — conflating
  "blocked outright" with "needs an extra tap" would make raising the
  trade cap also silently soften the confirmation threshold, and vice
  versa. They should be free to diverge (e.g. mainnet cap stays at $500
  while this app is young; the confirm threshold can be the same number by
  coincidence, or not).
- **`BeforeYouSign` (`components/intents/naira-payout-card.tsx`)** is the
  closest precedent for "one more thing before the wallet opens," but it is
  worth being precise about what it actually is: a passive countdown + an
  address-matching checklist panel, shown _alongside_ the existing sign
  button, not a gate the user has to clear. It doesn't block signing; it
  informs while the button is already live. The spend-limit step is
  different in kind — it must actually gate the primary button on trades
  over the threshold, because the whole point is to stop a reflexive tap.

## Design questions, answered

### 1. Where does the $500 check live — client, server, or both?

**Primarily client-side UX**, same framing as the trade cap's own doc
comment: a check this screen can skip is not a security boundary, the
wallet signature already is one. The confirmation step's entire job is to
interrupt the _user's_ reflex before they reach for their wallet; it has no
enforcement value against a malicious or compromised client, which could
simply not render it.

**But yes to server-side defense-in-depth, for logging only, not blocking.**
Two call sites already compute or receive enough to know the dollar size of
what's about to move:

- `/api/swap/build` (`app/api/swap/build/route.ts`) already imports
  `assertTradeWithinCap` and has the quote and the price table in scope.
- `logExecution` (`lib/server/analytics.ts`) already records every submitted
  transaction (`LogExecutionInput`), best-effort, never blocking.

Recommendation: compute `overThresholdUsd: boolean` (or the raw USD figure)
at submit time from the same price table `assertTradeWithinCap` already
uses, and add it as a field on the execution record. This gives two things
for free: (a) a way to notice in the data if large trades are going through
_without_ the client ever having rendered the confirmation (client bug, a
non-browser caller hitting the API directly, or a build that's missing the
component), and (b) a denominator for a future "how often does the
confirmation actually change behavior" analysis. It must never throw and
must never change the response shape the client depends on — same spirit as
`logExecution`'s existing "never in the way" comment.

Do **not** make `/api/swap/build` or `/api/swap/submit` refuse a trade for
lacking confirmation. That would turn a UX nudge into a second trade cap with
its own edge cases (what error message, does `onReset` catch it, does it
interact with `assertTradeWithinCap`'s own error) for no real security gain,
since a user who wants to skip the nudge can always decline in the wallet
instead — the wallet step is unaffected either way.

### 2. What does the extra step look like?

Recommend **(a), adapted**: a second deliberate action gated behind a short
delay, in the same visual slot as the existing primary button — not a modal,
not a checkbox.

Reasoning against the alternatives:

- **Modal requiring typed/confirmed amount**: too heavy for something that
  should feel like "one more tap," not an interruption to a different
  screen. `SwapConfirm` has deliberately kept everything in one card
  (per its own top comment: "a user reads exactly one thing before
  signing"). A modal breaks that model and reads as enterprise-wire-transfer
  friction on an app whose main traffic is small swaps.
- **Checkbox "I understand this trade is $X"**: cheap to build, but
  checkboxes are exactly the kind of control a reflexive, fat-fingering
  thumb clears without reading — the UI research reason checkboxes are
  avoided for "are you sure" moments. It satisfies the letter of "an extra
  step" while doing nothing for the actual failure mode (inattention).
- **Second button + short cooldown** (chosen): matches `BeforeYouSign`'s
  existing use of a visible timer as a forcing function, costs about 2–3
  seconds of real delay (not interruption) on genuinely large trades only,
  and keeps everything inside the one card.

**Concrete shape**, matching `swap-confirm.tsx`'s existing structure:

- Below `LedgerPreview` and above the existing button row, when (and only
  when) the trade's USD value crosses the threshold, render a line like:

  > This trade is worth about **$5,000**. Confirm you want to send this
  > much.

  styled like the existing `distorted` / slippage warning text (`text-xs`,
  one line, no icon-heavy treatment — this is a notice, not an alarm).

- The primary button (`PRIMARY`, currently "Sign & swap") is disabled for a
  short cooldown (recommend **2 seconds** — enough to break a reflex tap,
  not enough to feel like a wait) starting the moment the review screen
  renders with a known over-threshold amount. While disabled, its label
  shows the countdown, e.g. "Sign & swap (2s)", the same way `busy` already
  swaps the label today. Once the cooldown elapses, the button behaves
  exactly as it does now — no second click, no separate confirm action. The
  friction is entirely the wait, not an extra tap, because an extra tap is
  itself something a reflex can clear.
- `Cancel` remains enabled and untouched throughout — the delay only ever
  gates the money-moving action, never the escape hatch.
- If the quote changes (new `route` prop, e.g. user edits the intent and a
  new quote comes in) while on this screen, the cooldown resets — it is
  reusing `useSwapExecution`'s existing per-`route` effect boundary
  (`use-swap-execution.ts` lines 88–126 already reset state per new
  `route`), so this falls out of the existing effect rather than needing new
  wiring.

This keeps the change almost entirely inside `SwapConfirm` (a new small
piece of state and a disabled/countdown button) plus one boolean the caller
already has everything to compute (`sendUsd`/`receiveUsd`, already derived
in the component from `usdPrices`).

### 3. Is $500 USD-equivalent the right unit, and is it computable up front?

Yes to both, with one precision: **use the larger of the two legs' USD
value**, not just the sent side, and compute it from `usdPrices` exactly as
`sendUsd`/`receiveUsd` already are in `swap-confirm.tsx` (lines 331–332).
That is the same `market.prices` table `LedgerPreview`'s caller
(`useSwapExecution`) already fetches via `fetchMarketPricesFromRoute`
(`lib/swap/prices-client.ts`) — no new price source, no new fetch.

Using the max of the two sides (rather than only what's sent) matters
because the two legs can disagree sharply on testnet (`swap-confirm.tsx`'s
own `distorted` check exists for exactly this reason) and, even on mainnet,
because the dollar amount a user should be startled by is whichever number
is bigger, not specifically the outgoing one.

Edge case: when `usdPrices` hasn't loaded yet (brief window on mount,
`use-swap-execution.ts` lines 72–84) or a symbol has no price entry, the
threshold check cannot be evaluated. Recommend treating "unknown" as _not_
over threshold for the UI nudge — unlike the server-side `trade-cap.ts`,
which deliberately refuses an unvaluable trade (its own comment: "a trade
that cannot be valued is refused rather than waved through"), this is a
soft nudge, not a cap, so failing open (no extra friction) is the right
default: you cannot reflex-protect a number you can't show, and showing a
blocking spinner on every swap waiting for a price feed would add real
friction to the common case to guard a rare one.

### 4. Should the threshold be configurable?

**Yes**, same shape as `RATE_LIMIT_<FAMILY>` (`lib/server/rate-limit.ts`):
a single env var with a sane default, parsed defensively so a typo keeps
the previous behavior rather than silently disabling the feature.

Recommend `SWAP_CONFIRM_THRESHOLD_USD`, default `500`, read the same way
`tradeCapUsd` reads `MAINNET_MAX_TRADE_USD` (`lib/server/trade-cap.ts` lines
32–44): trim, parse, and on anything non-positive or unparseable, fall back
to the default rather than throwing or disabling the check. Unlike the rate
limit family's `count/seconds` pair, this is a single number, so the parse
is simpler than `limitFor`'s regex — closer to `tradeCapUsd`'s own
`Number(raw)` + `Number.isFinite` + `> 0` guard.

One difference from `tradeCapUsd`: that function only applies on mainnet
(`if (network !== 'mainnet') return undefined`). This threshold should
apply on **both networks**. Testnet trades still train the same reflex and
the same agent-reasoning failure modes the UX nudge is meant to catch, and
testnet is exactly where the `distorted` synthetic-rate warning already
lives — a wildly-off testnet quote is arguably the single most likely
trigger for an oversized, fat-fingered-looking trade in practice.

Since the value only needs to reach the client to decide whether to show
the nudge (this is explicitly not a server-enforced boundary), it can be
read with `NEXT_PUBLIC_SWAP_CONFIRM_THRESHOLD_USD` and inlined at build
time the way other client-visible config in this app already is, **or**
passed down from a server component / the `/api/swap/build` response if the
codebase prefers not to grow the `NEXT_PUBLIC_` surface — worth a quick check
of how `trade-cap.ts`'s cap itself is surfaced to the client today (it isn't,
currently — the cap only shows up as a thrown error after the fact), rather
than inventing a second mechanism. **Flagging as a call for whoever picks
this up**: grep for existing `NEXT_PUBLIC_` env vars before choosing; if none
exist, lean towards passing it down through the existing `/api/swap/build`
response (it already returns `{ preview }`; adding one more field is small)
to avoid a new client-config pattern for a one-off value.

### 5. Chained swap-then-cashout (`intent-chat.tsx`'s `cashOutAfterSwap`)

This needs an explicit recommendation because the naive per-screen check
genuinely misses the risk it's meant to catch: a $300 swap into USDC
followed immediately by a $300 cash-out is, from the user's perspective, one
$300 action they took once, under one intent — the chaining is invisible to
them. But a user who intends a $600 swap-then-cash-out, where each leg is
kept under $500 specifically to dodge scrutiny (plausible for "bad-agent-
reasoning" framing: an agent that split a large order into two chained legs
specifically because it had internalized a $500 ceiling), is exactly the
case this feature exists to catch, and per-leg checking lets it through on
both screens.

**Recommendation: check the chain's total, not each leg**, but only when
the chain is already known at the time the first leg's `SwapConfirm` screen
is shown. Concretely: when `cashOutAfterSwap` is true (set in
`intent-chat.tsx` before the swap even starts, so it's known in time), pass
the _eventual_ cash-out amount down into `SwapConfirm`'s threshold
calculation as an additional add-on, so the first leg's confirm screen
reasons about the combined total — not just its own leg. The second leg
(the cash-out form itself, in `naira-payout-card.tsx`) does **not** need its
own separate threshold check once the first leg already confirmed the
combined total; re-prompting on the second leg for the same money would be
exactly the over-friction this design is trying to avoid, and the amount
reaching the payout form is bounded by what already arrived from leg one.

This does mean `SwapConfirm` needs one more optional prop
(`chainedUsd?: number` or similar) that `intent-chat.tsx` fills in only when
`cashOutAfterSwap` is set and the downstream amount is already known (it is
— the whole point of the chain is that the agent already picked a payout
amount before the swap runs). If the downstream amount is _not_ yet known
at the time the swap screen renders (e.g. some future flow where the
cash-out amount is decided only after the swap settles), this recommendation
doesn't apply and per-leg checking is the honest fallback — flagging this
as the one piece of the chained case that depends on how
`cashOutAfterSwap`'s amount is actually known today, worth a quick re-read of
`intent-chat.tsx` around lines 179–185 and 636–648 before implementing to
confirm the amount actually is available early enough.

## Task breakdown

1. **Threshold config** — add `swapConfirmThresholdUsd(env?)` next to (not
   inside) `lib/server/trade-cap.ts`'s pattern: parse
   `SWAP_CONFIRM_THRESHOLD_USD`, default `500`, defensive fallback on bad
   input. Decide client delivery mechanism (new `NEXT_PUBLIC_` var vs.
   threading through `/api/swap/build`'s response) — resolve the open
   question in §4 first.
2. **USD-size helper in `SwapConfirm`** — extract the existing
   `sendUsdRaw`/`usdValue` logic (already in `swap-confirm.tsx`) into a
   `tradeUsd(sendDisplay, receiveDisplay, quote, usdPrices)` that returns the
   max of the two legs; add the optional `chainedUsd` add-on from §5.
3. **Cooldown UI** — add `overThreshold` state to `SwapConfirm`: a notice
   line (per §2's copy) and a disabled-with-countdown primary button,
   reusing the existing `busy`/label-swap pattern. Reset the cooldown when
   `quote` changes (falls out of `useSwapExecution`'s existing per-`route`
   effect).
4. **Chained-intent wiring** — `intent-chat.tsx` passes the known cash-out
   amount into `SwapConfirm` as `chainedUsd` when `cashOutAfterSwap` is set
   before the swap starts. Confirm (re-check code, not just this doc) that
   the amount is actually known that early.
5. **Server-side logging only** — add the computed USD size (or an
   `overThreshold: boolean`) to `LogExecutionInput` / `logExecution`'s
   record, computed in `/api/swap/submit` from the same price table
   `assertTradeWithinCap` already fetches. No blocking behavior, no new
   error path, never throws.
6. **No changes** to `lib/server/trade-cap.ts`, `MAINNET_MAX_TRADE_USD`, or
   `BeforeYouSign` — both are reused as reference points only, not as
   shared code, per the reasoning in "Prior art" above.

## Explicitly out of scope

- Any server-side _blocking_ of unconfirmed large trades. The wallet
  signature remains the only real authorization boundary.
- Touching `MAINNET_MAX_TRADE_USD` / `trade-cap.ts`. Different feature,
  coincidentally similar default.
- A modal or any screen other than the existing `SwapConfirm` card.
- Per-leg confirmation on the cash-out form when the swap leg already
  confirmed the combined total (§5).

---

# Retuning `compete`'s rate limit for public traffic

Every `/api/agents/compete` race is five concurrent provider calls (default
roster: Claude, DeepSeek, Groq, two of the three OpenRouter free models), and
one of those five is billed per token with no free tier. The current window —
10 requests / 60s, keyed per address or IP — was sized for development, not
for a caller who can script a loop. This note works out what a race actually
costs, where the current key is weak, and what to change before the dapp
takes public traffic.

## 1. Cost per race, and what 10/60s actually buys an abuser

Only `anthropic` (Claude Sonnet 5.5) is priced above zero in
`lib/agents/brains/providers.ts`: $2/MTok in, $10/MTok out. Every other seat —
DeepSeek, Groq, the two OpenRouter free models — is `{ input: 0, output: 0 }`
on the provider's own free tier, so in dollar terms they cost nothing _to us_
per call. They still cost availability (a free-tier 429 benches that model
for everyone, per `lib/agents/lineup.ts`), which matters for §3, but not
dollars, so the dollar math below is carried by Claude alone.

Measured inputs, not guessed:

- Claude's own comment in `providers.ts` says ~2,300 input tokens per race.
- The eval fixture
  (`lib/agents/evals/results/deepseek-v4-flash-...json`) shows completions in
  the 760-940 token range for the same prompt shape on DeepSeek; Claude's
  `output_config: { effort: 'medium' }` (`brains/anthropic.ts`) targets the
  same brevity, so 900 output tokens is a fair planning number, not a
  worst case (a verbose answer could run higher, but tool-call-shaped output
  on a bounded schema rarely blows past this).

Per-race Claude cost:

```
input:  2,300 / 1,000,000 * $2  = $0.0046
output:   900 / 1,000,000 * $10 = $0.0090
                                   -------
                                   $0.0136 / race  (~1.4 cents)
```

Call it **$0.0136/race**, rounding up for safety margin on output length.

**Current limit, sustained:**

```
10 races / 60s  =>  $0.136 / minute / key
                 =>  $8.16  / hour   / key    (if sustained, which a script can do)
                 =>  $195.84 / day   / key    (24h sustained)
```

$196/day from one unauthenticated key sustaining the current limit nonstop is
not a rounding error — it is a budget line, and it is attacker-controlled: a
handful of IPs or wallets running this in parallel turns a $200/day exposure
into a $2,000+/day one without needing anything clever. The _non-dollar_ cost
compounds this: 10 req/60s per key saturates the free-tier models (Groq's
documented 1,000 req/day, OpenRouter's 50/day per key — see §3) long before
it threatens Claude's budget, so by the time the dollar ceiling is reached
the free seats have likely already gone dark for every _other_ caller on
that shared OpenRouter key.

**Verdict: 10/60s is a dev-testing number, not a public one.** It was almost
certainly chosen to let a developer run several races back-to-back while
iterating, not against a cost model. It is also not what's actually
protecting the budget today — the OpenRouter/Groq free-tier benching in
`lineup.ts` happens to cap sustained abuse _for those providers_ sooner than
the 60s window would, but Claude has no such backstop; it runs every race,
every time, regardless of how exhausted the free seats are.

**Recommendation: 4 requests / 60 seconds per key for `compete`.**

Reasoning: a real user races 1-3 times to settle on an intent, waits for a
result, then submits or walks away — nothing about the product's actual
interaction shape needs double-digit races per minute. 4/60s is generous
headroom above that real usage pattern while cutting the worst-case sustained
burn by 60%, to:

```
4 races / 60s => $0.0544 / minute / key
              => $3.26   / hour   / key (sustained)
              => $78.34  / day    / key (24h sustained)
```

Still not nothing at scale with many keys, which is exactly why §3 adds a
second cap underneath it.

## 2. How "per key" is scoped today, and the actual weakness

`enforceRateLimit` (`lib/server/rate-limit.ts`) checks **both** an IP key and
an account key when an account is known, and refuses if _either_ is
exhausted:

```ts
const keys = [`ip:${clientIp(request, deps?.env)}:${family}${scope}`]
if (account !== undefined && account !== '') keys.push(`account:${account}:${family}${scope}`)
```

But at the call site, `app/api/agents/compete/route.ts` calls
`enforceRateLimit(request, 'compete')` with **no third argument** — `account`
is never passed. So for this one family, in this one route, the account key
never exists: **`compete` is rate-limited by IP alone**, full stop, wallet
connection or not. That's actually the opposite of what the read-first brief
flagged as the risk to check, and it changes which weakness applies:

- The "switch wallets to bypass" bypass **does not apply to `compete`** —
  there is no address key here to switch away from. A wallet swap buys an
  abuser nothing against this family today.
- The weakness that _does_ apply is the standard one for any IP-only limiter:
  **one IP can be many real users.** A race happens pre-connection by design
  (a user types an intent before linking a wallet), so IP is the only signal
  available at that point regardless — this isn't an oversight so much as a
  consequence of where in the flow the check has to run. But it means a
  campus, office, café, or carrier-NAT IP shares one budget, and conversely a
  single abuser behind a residential-proxy rotator can cycle IPs for
  effectively unlimited budget against this limiter alone.
- `clientIp`'s documented fallback — no usable header groups every request
  under one shared `unknown` bucket — is a second-order version of the same
  risk, scoped to deployments with no fronting proxy; on Vercel (the
  documented production target, given `VERCEL_HEADERS`) this should not
  trigger, but it's worth confirming in whatever environment actually serves
  production traffic.

**Mitigation, in order of value for the cost this creates:**

1. **Do nothing clever at the IP layer for v1.** IP pooling (shared offices)
   under-limits a _few_ legitimate users sharing a budget — annoying, not
   costly. IP rotation (a real attacker) is the side that costs money, and no
   per-IP scheme stops a motivated rotator; only a global or account-tied cap
   does (see §3's daily cap, which is the actual backstop here).
2. **Once an account is known, layer it in**, the same way `enforceRateLimit`
   already supports for every _other_ family. The call site should pass the
   caller's address as soon as the UI has one (e.g. a race run from an
   already-connected session), so a connected abuser faces both the IP
   bucket and their own address bucket — closing exactly the "switch
   wallets" gap §2's premise asked about, for the _connected_ case, even
   though pre-connection races can't benefit from it. This is a one-line
   change at the call site (pass `account` through when available) with the
   existing dual-key machinery doing the rest — no new mechanism needed.
3. **Treat `unknown`-bucket pooling as a production alert, not a design
   gap**: if `clientIp` ever returns `'unknown'` in production, that means
   the proxy headers Vercel is expected to set are absent, which is itself
   worth knowing about independent of rate-limiting.

## 3. A daily cap, separate from the 60-second window

The 60s window bounds _burst rate_; it does not bound _total daily spend_ per
key, because a key that stays just under the per-minute ceiling for 24
hours straight pays the sustained-rate number from §1 regardless of how low
that per-minute ceiling is. A daily cap is the right tool for "bound the
worst case," because it is the number that actually appears in a monthly
bill.

**Recommendation: add a `compete-daily` family (or extend `RateLimitFamily`
with a second window check at the call site) capped at 150/day per key.**

Reasoning, worked from the budget side rather than picked round:

```
150 races/day * $0.0136/race = $2.04 / day / key, worst case
```

$2/key/day is a tolerable ceiling for a single IP or account even if it's
being hammered continuously, and it comfortably covers real usage: 150
races/day is ~6/hour sustained for 24 hours, far above what any genuine user
session looks like (a handful of races per sitting, a few sittings a day).
It also happens to land close to the free-tier ceilings already enforced
upstream — OpenRouter's 50 req/day _per key for the whole deployment_ (not
per caller) and Groq's 1,000 req/day deployment-wide — which is a second
reason not to go much higher: a single caller consuming 150 compete races
alone would already be eating a meaningful share of the _deployment's_
shared free-tier budget for those providers, regardless of what Claude costs
them individually.

Mechanically this reuses `checkRateLimit`/`limitFor` as-is: same fixed-window
counter, same Postgres table, a second row keyed `...:compete:daily` with
`windowSeconds: 86400` and `limit: 150`, checked alongside (not instead of)
the per-minute window in `enforceRateLimit`. No new storage engine, no new
column — just a second call into the existing `check()` with a longer
window, which the current `RateLimitInput`/`RateLimitWindow` shapes already
support without modification.

## 4. Rate-aware agent selection (optional, future)

Worth flagging, not worth building now: `lineUp()` already removes agents
for provider-side reasons (free-tier exhaustion). It would be _possible_ to
extend that same gate with a caller-aware signal — e.g. "this key has run
20+ races in the last hour; drop the paid Claude seat for its races and run
only the free models" — which would cap cost exposure per caller
independent of whether the request-level limit catches them before the
budget damage is done.

This is explicitly a stretch idea for later, for two reasons: (1) `lineUp`
today takes only the roster, with no notion of "whose race is this," so
wiring caller identity through to that layer is a real plumbing change, not
a parameter tweak; (2) it duplicates what §1's limit plus §3's daily cap
already bound well enough that the marginal cost control is small relative
to the complexity of making agent selection caller-aware. Revisit if real
traffic shows per-minute + daily caps are not enough — e.g. if abuse shows up
as many distinct keys each staying just under both caps.

## 5. Fail-open on DB error: still the right call

Confirmed, with one addition. The documented reasoning in
`rate-limit.ts` — a limiter that takes the app down when its own store
blinks has the priorities backwards — still holds with real money involved:
the alternative (fail closed) turns a transient Postgres hiccup into a full
outage of every POST route in the app, including the ones that aren't
cost-sensitive (`build`, `resolve`, `standing`). Trading an availability
incident for protection against a cost incident that may not even be
happening is the wrong trade; a DB blip is far more likely than a sustained,
coordinated cost-abuse campaign landing in the exact same window.

The gap is observability, which the code already names but doesn't close:
`warnedUnreachable` logs **once per process**, to console, and is "then
quiet until the process restart." On a serverless deployment with many
short-lived instances, "once per process" can mean "logged many times
across many instances" or "barely logged at all," and either way nothing
reads server console output as an alert. The compensating control this
section asked about is exactly that gap:

**Recommendation: turn the existing warn-once log line into a real alert.**
Whatever the deployment already uses for alerting (if anything exists — this
wasn't visible from `rate-limit.ts` alone and is worth checking before
assuming a new integration is needed) should fire when
`[rate-limit] database unreachable` is logged, because that log line means
"the rate limiter — the only thing standing between the public internet and
a per-call Claude bill — is currently open for every caller, on every
family, including `compete`." That is a five-minute Postgres blip changing
from "invisible" to "a human knows within minutes," which is the right shape
of fix: it doesn't change the fail-open policy, it just makes the window
where the policy is actually exposed something somebody is paged for.

## Task breakdown

1. **Lower `compete`'s default limit** in `RATE_LIMIT_DEFAULTS`
   (`lib/server/rate-limit.ts`) from `{ limit: 10, windowSeconds: 60 }` to
   `{ limit: 4, windowSeconds: 60 }`. One-line change; `RATE_LIMIT_COMPETE`
   env override continues to work unchanged for anyone who needs to tune it
   per deployment.
2. **Add the daily cap.** Either extend `RateLimitFamily` with a
   `compete-daily` member sharing the same DDL/table, or add a second
   explicit `checkRateLimit` call inside `enforceRateLimit` (or a
   `compete`-specific wrapper) using `{ limit: 150, windowSeconds: 86400 }`.
   Prefer whichever keeps `enforceRateLimit`'s generic signature intact for
   the other five families, since they don't need a second window.
3. **Pass `account` through at the `compete` call site** once a wallet is
   connected, matching every other family's existing call pattern
   (`enforceRateLimit(request, 'compete', account)`), so a connected abuser
   is bounded by address in addition to IP. No change needed inside
   `rate-limit.ts` itself — the dual-key logic already exists and is unused
   here only because the argument isn't passed.
4. **Wire the "DB unreachable" log to real alerting**, using whatever
   alerting path the deployment already has (check first — this doc doesn't
   assume one exists). Keep the one-line-per-process log as is; add a
   notification on the same branch in `checkRateLimit`'s catch block.
5. **(Optional/future, do not block on this)** Revisit caller-aware agent
   selection in `lineup.ts` only if production data shows §1+§3's caps are
   insufficient — e.g. many distinct keys each riding just under both
   limits. Not scoped as a task now; flagged so it isn't forgotten if the
   numbers above turn out to be wrong once real traffic arrives.

---

# Error recovery for chained swap-then-cash-out intents

Scope: "swap XLM to USDC then cash out to naira" and its relatives — any
instruction `startSwapThenCashOut` opens, in `intent-chat.tsx`. This is the
**chat-orchestrated** chain: a plain swap card (`useSwapExecution`), then,
once it settles, a second `NairaPayoutCard` instance rendered standalone at
line ~2375. It is a different code path from `sequence.prepare({ kind:
'swap-then-naira' })`, which signs both legs as one sequence from the review
card up front (chosen when the user supplies bank details _before_ picking an
agent, via `onConvertFirst`). Both exist; this doc covers the first, since
that's what "swap then cash out" in free text produces today, and notes where
the second's recovery story differs.

## How the chain is wired today

- `startSwapThenCashOut(symbol, amount)` sets `cashOutAfterSwap = true` and
  parses a plain swap intent (`Swap <amount> <symbol> to USDC`). No cash-out
  state exists yet — just a flag.
- The user picks an agent and signs through the ordinary `SwapConfirm` card,
  driven by `useSwapExecution`'s phase machine (`idle → review → signing →
submitting → settled | failed`).
- The "Settle effect" (`intent-chat.tsx:638-647`):
  ```ts
  const swapSettled = swap.phase === 'settled'
  useEffect(() => {
    if (!swapSettled || !cashOutAfterSwap || address === undefined) return
    const settled = { hash: swap.hash ?? '', receive: swap.receiveDisplay ?? '' }
    void queryClient
      .refetchQueries({ queryKey: ['stellar-balances', address] })
      .finally(() => setCashOutFrom(settled))
  }, [swapSettled, cashOutAfterSwap])
  ```
  This is the only trigger for opening the cash-out form. It keys strictly off
  `swap.phase === 'settled'`, which `useSwapExecution` sets only after
  `submitSignedSwap` (or the UI-level `/api/swap/submit`) returns `ok: true`
  with a real ledger result (`use-swap-execution.ts:227-232`). A `failed`
  phase — including the `unconfirmed` reason — never satisfies this condition.
- Once `cashOutFrom` is set, a second `NairaPayoutCard` mounts at line ~2375
  with `asset="usdc"`, sized from `cashOutFrom.receive` clamped to the
  refetched USDC balance (`cashOutUsdc`), independent of the swap card above
  it (which still shows its own "Swap complete" / Done state, per #140).
- `releaseSwap()` resets the swap card and clears `executingKey`, but
  deliberately never touches `cashOutFrom` — that's the point of #140 keeping
  the two states apart.

## Scenario 1 — swap succeeds, cash-out order creation fails immediately (bad bank details)

**What happens today.** Once `cashOutFrom` is set, the swap card above still
reads "Swap complete" with its explorer link (`SwapConfirm`'s `settled`
branch), and does not disappear — #140 made that permanent. Below it sits the
system pill `"Swap settled. Now cash out your USDC to naira."`
(`intent-chat.tsx:2377`) and then the fresh `NairaPayoutCard`. If the form
submission fails (e.g. `/api/naira/verify` rejects the account, or `create()`
in `use-naira-payout.ts` throws), the card renders its `failed` branch
(`naira-payout-card.tsx:521-543`): the error message, an "unknown" caveat if
the status was 504, and a "Back to the form" button that calls `edit()` —
which returns to `phase: 'form'` on the _same_ `useNairaPayout` instance, so
the amount/bank fields are not lost.

**Verdict: adequate.** The swap's own success stays visibly on screen (its
own card, its own explorer link) the whole time the cash-out form is being
retried below it — there is no shared reset path that could make the user
think the swap also failed. "Back to the form" is a same-card retry, not a
restart of the chain. The one gap: the system pill above the form says
"cash out your USDC to naira" but never repeats _how much_ USDC the swap just
delivered or restates the swap's hash once the card is scrolled past — a user
who scrolls down first and only sees the cash-out form's failure has to
scroll back up to re-confirm the swap really went through. Minor, not a
correctness or ambiguity problem.

## Scenario 2 — swap succeeds, cash-out is submitted but the anchor/payment fails after the user already paid in

**What happens today.** This is the `tracking` phase of `NairaPayoutCard`
(`PayoutProgress`, `naira-payout-card.tsx:128-224`), driven by `useNairaPayout`
polling the order by id. `STATUS_COPY` covers exactly this case:

```
failed: 'The bank transfer failed. Your XLM is returned to your account.'
expired: 'No deposit arrived in time, so this payout was cancelled. Nothing was taken.'
```

Both render with `tone === 'warning'`, title "Payout stopped", and the
copy above as the subtitle/body. There is no retry button on this card in the
`tracking` phase — once an order is created and the user has sent the
deposit, `failed`/`expired` are terminal states with no second attempt wired
up (contrast with the `swap-then-naira` sequence path, which does get a
"Try the payout again" button at `intent-chat.tsx:2201-2211`, but only for
that other code path, keyed on `sequence.phase === 'failed'`).

**Verdict: partially adequate, with one real gap.** The status copy is honest
and specific — it distinguishes "sent back to you" from "cancelled, nothing
taken," which is exactly the ambiguity a user in this state would panic over.
But:

1. **No retry affordance** in the chat-orchestrated flow (unlike the sequence
   flow, which already has one for the same underlying `failed` status). A
   user whose payout failed has no on-screen way to try again except typing a
   fresh cash-out instruction from scratch, discarding the now-irrelevant swap
   context — which is actually fine for `failed`/`expired` since the funds are
   back in their XLM/USDC balance and a fresh "cash out my USDC to naira" works
   — but it isn't _said_, so the user has to infer "I should just ask again."
2. **The claim "returned to your account" is asserted but not verified in the
   UI.** There is no balance re-check or confirmation step showing the
   returned funds landed; the user is asked to trust a static string.

## Scenario 3 — swap itself is "unconfirmed" — does the chain correctly wait for real confirmation?

**What happens today.** Yes — this is handled correctly, and it's worth
tracing exactly why. `submitSignedSwap` (`lib/swap/submit.ts`) returns
`{ ok: false, reason: 'unconfirmed', hash }` for a transaction whose fate
Horizon never confirmed inside `pollTimeoutMs`. `useSwapExecution.confirm()`
takes that branch at `use-swap-execution.ts:207-224`:

```ts
if (result.ok !== true) {
  setState((s) => ({ ...s, phase: 'failed', error: ..., ...(hash ? { hash, explorerUrl } : {}) }))
  return
}
```

`phase` becomes `'failed'`, never `'settled'`. The Settle effect in
`intent-chat.tsx` triggers _only_ on `swap.phase === 'settled'`
(`const swapSettled = swap.phase === 'settled'`), so an `unconfirmed` outcome
cannot open the cash-out form — there is no race condition here. The chain
correctly treats "may have landed, unconfirmed" the same as any other
failure for the purpose of gating step 2: it simply does not start it.

Where the user lands instead: `SwapConfirm`'s `failed` branch
(`swap-confirm.tsx:293-328`). It shows `FAILURE_MESSAGES.unconfirmed` — "The
network did not confirm the transaction in time. It may still go through:
check your wallet or the explorer before trying again." — with the explorer
link shown whenever `hash` is present (which it is here), and the subtitle
correctly says "Check the transaction before trying again" rather than
"Nothing was spent" (that branch already distinguishes on `explorerUrl !==
undefined`, i.e. on hash presence, exactly matching an unconfirmed-with-hash
case). "Try again" calls `releaseSwap()`, which resets to `idle` and lets the
user pick an agent again — if the original swap actually lands later, this
produces a genuine double-swap risk, but that risk is about the generic retry
affordance applying to `unconfirmed` same as any other failure, not about the
cash-out chain racing ahead.

**Verdict: adequate for the specific question asked** (does cash-out wait for
real confirmation — yes, correctly, via the phase gate). **Separate,
pre-existing gap, not specific to the chain:** "Try again" after an
`unconfirmed` failure re-signs and resubmits without first checking whether
the original transaction actually landed, which could become a double swap
if the original does land after the retry's. This is a real gap but it is
symmetric with any solo swap's unconfirmed-then-retry case; chaining a
cash-out onto it does not make it worse, it just means a swap that can double
up is now also gating a bank transfer.

## Scenario 4 — user navigates away / closes the tab mid-chain

**What happens today.** None of the chain's state is persisted anywhere that
survives a reload:

- `cashOutAfterSwap`, `cashOutFrom`, `nairaConvert` are plain `useState` in
  `IntentChat`, gone on unmount.
- `saveTurn`/`updateTurn` (chat history, `lib/chat-history.ts`) record the
  _swap's_ outcome once settled (`settledHash` effect at lines 449-479 calls
  `updateTurn(turnId, { txHash: settledHash })`), and separately record a
  cash-out form being opened (`cashoutFormOutcome`, lines 601-610) and an
  order's outcome once placed (`cashoutOutcome(order)` in the `onOrder`
  callback at line 2156). So the swap leg and a _placed_ cash-out order are
  each individually recorded to chat history and (for the order) the
  `cashouts` query — reopening history or the Naira order tracker can recover
  each leg's own status independently.
- What is **not** recorded anywhere: the fact that these two legs were one
  chain, and specifically the state "swap settled, cash-out form opened but no
  order created yet." If the user closes the tab after the swap settles but
  before submitting the cash-out form (i.e. while `cashOutFrom` is set but no
  `naira-payout-card` order exists), nothing survives. Reopening the app shows
  the swap in history (its own turn, with hash) and nothing says "you still
  have USDC sitting there waiting to be cashed out" — the user has to
  remember on their own and re-issue "cash out my USDC to naira."

**Verdict: this is the one real gap of the four.** It is also the lowest
severity of the two real gaps found (scenario 2's missing retry affordance is
higher severity, since it's gating a payout the user has to re-request from
first principles vs. simply re-noticing a balance). Funds are never at risk —
USDC sitting in the wallet is not lost, and the swap is fully recorded in
history — so this is a _discoverability_ gap, not a safety one. But "told
unambiguously what state their funds are in" is exactly what the task asked
for, and today that information exists only in the user's head between the
swap settling and the cash-out order being created.

## Gaps, prioritized

1. **(Medium) No persisted "pending cash-out" reminder across a reload.**
   Scenario 4. Between swap-settled and cash-out-order-created, state lives
   only in React memory. A closed tab loses the thread; the user must notice
   their own USDC balance and re-ask.
2. **(Medium) No retry affordance on a terminal `failed`/`expired` payout in
   the chat-orchestrated flow.** Scenario 2. The sibling `swap-then-naira`
   sequence path already has "Try the payout again" for the analogous state;
   the standalone post-swap `NairaPayoutCard` at line ~2375 has no equivalent,
   leaving the user to start a brand new cash-out instruction from scratch
   without being told that's the expected next step.
3. **(Low) The swap's hash/amount is not restated at the point of a
   cash-out-step failure.** Scenario 1. The information exists (the swap card
   above), but nothing re-anchors it beside a failure that appears below a
   long scroll.
4. **(Pre-existing, not chain-specific — informational only) Retrying an
   `unconfirmed` swap can double-submit if the original lands late.** Noted
   under scenario 3 for completeness; fixing it is a `useSwapExecution`/retry
   concern independent of the cash-out chain, so it is out of scope for this
   doc's task breakdown but worth flagging to whoever owns `swap-confirm.tsx`.

## Proposed changes

### For gap 1 — persisted pending-cash-out banner

- Add one field to the chat-turn record (`lib/chat-history.ts`'s `ChatTurn`)
  written by the Settle effect itself, right where it currently calls
  `setCashOutFrom(settled)`: `{ pendingCashOut: { hash, receive: settled.receive } }`
  on the same `turnId`. Cleared (`pendingCashOut: undefined`) by the existing
  `onOrder` callback once an order is actually created, the same place that
  already writes `cashoutOutcome(order)`.
- On load (`syncTurns`/the history-restore path), if the _most recent_ turn
  for the connected wallet has `pendingCashOut` set and no superseding
  `outcome`, show a dismissible banner above the composer: "Your swap into
  USDC settled — cash out `<amount>` USDC to naira?" with a button that calls
  `startSwapThenCashOut`'s tail end directly (i.e. re-opens the post-swap
  `NairaPayoutCard` seeded from the recorded amount, skipping the swap step
  entirely since it already happened). Dismissing just hides the banner; it
  does not delete the record, since the USDC is still sitting there either
  way.
- This only needs to fire for the _latest_ turn, not a general inbox — chasing
  every historical incomplete chain is out of scope and risks surfacing stale
  reminders for cash-outs the user abandoned on purpose.

### For gap 2 — retry affordance on a terminal payout failure

- Mirror the sequence flow's existing pattern. In `naira-payout-card.tsx`'s
  `tracking` branch (`PayoutProgress`), when `status` is `'failed'` or
  `'expired'`, add a "Cash out again" button that calls a new `onRetry` prop
  rather than leaving the card as a dead end. `IntentChat` wires it to the
  same path the pending-cash-out banner above uses: re-open a fresh
  `NairaPayoutCard` seeded from the USDC balance actually on hand (re-read via
  `refetchQueries(['stellar-balances', address])`, not from the stale
  `cashOutFrom.receive`, since a `failed` order may have changed the balance
  by returning funds).
- This is additive to `PayoutProgress`'s props and does not change
  `useNairaPayout`'s state machine — "again" means mounting a new card/hook
  instance (`key={...}` bump), not resuming the failed one, consistent with
  how `edit()` already works for the pre-submission `failed` branch.

### For gap 3 — restate the swap's outcome beside a cash-out failure

- In the `NairaPayoutCard`'s `failed` branch (line ~521-543), accept an
  optional `contextNote` prop. `IntentChat` passes `` `Your swap settled: you
received ${cashOutFrom.receive} USDC (tx ${shortHash}).` `` only on the
  post-swap instance (the one at line ~2375), never on the standalone
  cash-out-only instance (line ~2137) where there is no prior swap to
  restate. Rendered as a muted line above the existing error, not a new card.

## Task breakdown

1. `lib/chat-history.ts`: add optional `pendingCashOut?: { hash: string;
receive: string }` to `ChatTurn`; write it from the Settle effect in
   `intent-chat.tsx`; clear it from the existing `onOrder` callback on the
   post-swap `NairaPayoutCard`.
2. `intent-chat.tsx`: on mount/wallet-change, check the latest turn for a
   live `pendingCashOut` and render the reminder banner above the composer;
   wire its action to reopen the post-swap cash-out card from the recorded
   amount.
3. `naira-payout-card.tsx`: add `onRetry?: () => void` to `PayoutProgress`
   (threaded through `NairaPayoutCard`'s props), render "Cash out again" only
   for `status === 'failed' || status === 'expired'`.
4. `intent-chat.tsx`: wire the new `onRetry` on the post-swap card instance to
   remount a fresh `NairaPayoutCard` sized from a freshly refetched USDC
   balance.
5. `naira-payout-card.tsx`: add `contextNote?: string` to the component,
   rendered above the error text in the `failed` branch; `intent-chat.tsx`
   passes it only on the post-swap instance.
6. No changes needed to `use-swap-execution.ts`, `lib/swap/submit.ts`, or the
   Settle effect's trigger condition — scenario 3 audit found no bug there.

---

# Agent health monitoring

Today a dead model, an exhausted rate limit, or a revoked key is found by a
human running curl against production `/api/agents/compete` and reading
`vercel logs` by hand. This is the design for making that automatic: a check
that notices before a person does, and tells one without being asked.

## What's already there

Two things exist that this design builds on rather than duplicates:

- **`lib/agents/lineup.ts`** already tracks per-agent-key rate limits in
  memory (`benchedUntil`), but only within one server instance. A cold
  instance re-learns a limit from its own first 429. This state is not a
  health signal anything outside that instance can read, and it resets on
  every deploy and (per Vercel's serverless model) at unpredictable times
  between deploys too. It cannot be the source of truth for monitoring.
- **`agent_races` / `agent_proposals`** (`lib/server/analytics.ts`,
  `raceRecordFrom`/`logRace`) already store, per real race, which agents
  answered, their latency, and their failure code
  (`timeout` / `rate_limited` / `auth` / `invalid_response` / `error` — note
  `failureCode()` collapses the brain's own `invalid_schema` and
  `upstream_error` into `error`, and `no_api_key` and `refused` have no
  distinct bucket either; see "Gaps" below). `admin-metrics.ts`'s `agents()`
  reader already turns this into per-agent `races`/`answered`/`wins`/`p50`/`p95`
  and a `failures` breakdown, scoped by network and range (`7d`/`30d`/`90d`/`all`).
  There is no sub-hour range today, but the query shape — `WHERE r.network =
$1 AND r.started_at >= $2 GROUP BY p.agent` — needs nothing new to answer a
  "last 15 minutes" question; it just needs a smaller `$2`.

This second point is the basis for the recommendation below.

## 1. Passive vs. active: recommend passive, with active held in reserve

**Recommend passive**, i.e. query `agent_proposals`/`agent_races` for a
rolling window and alert on bad success rates, rather than a synthetic
scheduled call to a brain.

Reasoning:

- The data already exists and is already correctly shaped (per-agent,
  per-race, ok/failure, latency) — this is a read, not a new write path.
- Zero marginal API cost. An active check that calls `brain.propose()` on a
  schedule pays a real, metered bill on every tick forever, specifically on
  the paid providers (Claude, DeepSeek) this is supposed to protect money on.
- It reuses exactly the failure signal a human currently greps logs for —
  the same `[agents] ...` `console.warn` lines in `compete/route.ts` and the
  brains correspond 1:1 to the `failure` codes already landing in
  `agent_proposals`. Passive monitoring is "read the thing that already
  happens," not a parallel system that can itself drift out of sync with
  what users experience.
- Its real weakness — "only detects problems when real users are racing" —
  is a weak objection for this app specifically: `/api/agents/compete` is the
  core product action (every swap intent races agents before anything can
  execute), so on production this runs continuously during any hours someone
  would be swapping. The gap is only "no traffic at 3am local" exactly when
  there's also nobody being hurt by a quiet outage.

**When to revisit active:** if there's ever a period of genuinely no
production traffic for hours at a stretch (e.g. a pre-launch soft period, or
testnet-only operation) where a break could sit undetected until the first
real user hits it, add a _cheap_ active check as a supplement, not a
replacement:

- Hit a dedicated lightweight route, not `/api/agents/compete` — a full race
  prices a quote, builds market context, hits the order book, and calls every
  roster agent concurrently. None of that is needed to answer "is the
  provider reachable with a valid key." A health route would call
  `brain.propose()` directly (as instructed to read in `brains/index.ts`)
  with the smallest possible `ProposalRequest` — a fixed trivial intent, no
  market/route context — against **one or two agents only**, not the full
  roster.
- Pick the cheapest paid provider for the active probe (DeepSeek or Groq,
  not Claude) and treat Claude/OpenRouter as passively monitored only, since
  their real traffic volume already makes the passive signal fast.
- Interval no tighter than 10-15 minutes. At that cadence a single
  near-free-tier call per tick costs cents a month, not dollars.
- This is additive to passive, never a replacement: passive catches real
  degradation users are actually seeing; active catches "nobody's traded in
  3 hours and we don't know if that's demand or an outage."

## 2. Where it runs: Vercel Cron

No `vercel.json` exists anywhere in the repo today (checked `apps/dapp/` and
the repo root) — this is new config, not an edit to existing cron.

Recommend a **Vercel Cron Job** over a separate external cron service or a
new standalone process:

- The project is already a Vercel-deployed Next.js app (`runintent-dapp`,
  team `Cookit-Labs`) with Postgres already reachable from its serverless
  functions (`lib/server/db.ts`, used throughout `analytics.ts` and
  `admin-metrics.ts`). A cron-triggered route handler reuses that same
  connection path with no new infra, no new secret store, no new place for
  the admin token to leak.
- Vercel Cron requirements, confirmed against what this design needs:
  - Declared in `vercel.json` at the project root (`apps/dapp/vercel.json`,
    since that's the Vercel project root) as a `crons` array of
    `{ "path": "/api/...", "schedule": "<cron expr>" }` entries.
    - A route handler already exists in this shape pattern — this is the
      same `app/api/<name>/route.ts` convention as `admin/metrics`,
      `admin/waitlist`, etc.
  - Vercel invokes crons with a `GET` and no custom headers/body the route
    can rely on other than its own `Authorization: Bearer $CRON_SECRET`
    convention, so the route must authenticate the call itself — do **not**
    reuse `isAdminRequest`'s cookie path (crons send no cookie); instead gate
    on a bearer token compared against a `CRON_SECRET` env var the route
    checks directly, following the same HMAC/`timingSafeEqual` comparison
    style already used in `admin-session.ts`'s `adminTokenMatches`.
  - On the Hobby plan, cron schedules are limited to once a day; a 15-minute
    passive check needs at least a Pro plan (accounts allow per-minute/hourly
    schedules there). This needs to be confirmed against whatever plan
    `Cookit-Labs` is actually on before committing to a sub-hourly interval —
    if it's Hobby, the realistic floor is once daily, which is a materially
    weaker guarantee ("alerted the next day" vs "alerted within 15 minutes")
    and the design should say so explicitly rather than assume Pro.
  - Cron routes run with the same execution limits as any other serverless
    function on the plan (duration, memory) — a passive DB query is well
    inside any tier's limits; this only matters if the active/hybrid option
    above is ever added, since an LLM call can run tens of seconds.

External cron (e.g. a third-party scheduler hitting a public endpoint) was
considered and rejected: it adds a dependency and a new secret
(`CRON_SECRET` would still be needed either way, so it buys nothing), and
Vercel Cron is simplest exactly because nothing new has to be told where the
app lives.

## 3. Alerting mechanism

There is no existing alerting integration in this repo (checked for Slack/
Discord/PagerDuty/email SDKs and env vars — none found). Rather than pick a
vendor, the design should be a **generic webhook POST to a configurable URL**
— it works unmodified with Slack incoming webhooks, Discord webhooks, or
anything else that accepts a POST, and costs nothing to build speculatively
for a vendor the user might not actually have.

Design:

- One env var, e.g. `AGENT_HEALTH_WEBHOOK_URL`. Absent → the check still runs
  and logs its own `[agents] health: ...` `console.warn` (so it's at least
  visible in `vercel logs`, consistent with how every other warning in this
  codebase surfaces today), but sends nothing. Never a hard failure: a
  missing webhook must not break the cron route itself.
- POST body kept to plain fields any webhook receiver can render without
  per-vendor formatting (`{"text": "..."}` is literally the Slack/Discord
  incoming-webhook shape already, so no translation layer is needed for
  either):
  ```json
  {
    "text": "<one-line summary — e.g. 'Intent agent health: deepseek 0/8 answered in last 15m (auth)'>",
    "severity": "critical" | "warning",
    "network": "mainnet",
    "checkedAt": "<ISO timestamp>",
    "agents": [
      { "agent": "...", "model": "...", "answered": 0, "races": 8, "lastFailure": "auth" }
    ]
  }
  ```
- Debounce so a sustained outage doesn't re-alert every tick forever: track
  "last alerted at" (in the DB — a small `agent_health_alerts` table, or
  simplest, a single row keyed by agent — rather than in memory, since memory
  doesn't survive cold starts any more reliably than `lineup.ts`'s bench
  does) and only re-send after some quiet period (e.g. re-alert at most once
  per hour per agent while the condition persists), plus always send a
  one-time "recovered" message when an agent that was alerting comes back
  above threshold.
- **Open question to ask the user rather than guess:** which webhook target
  they actually have (Slack incoming webhook URL, Discord webhook URL, or
  something else) — the POST body above works for either as-is, but Slack
  and Discord both also support richer block/embed formats, which can be
  added later cheaply as a vendor-specific enhancement once it's known which
  one is real. Don't build that enhancement speculatively.
- At minimum, independent of whether a webhook is configured: the existing
  `admin/metrics` `agents` view already shows this data to a human who opens
  the dashboard — that's the fallback dashboard-page option, and it already
  exists today, it just isn't windowed to "last 15 minutes" or badged red/
  green. A small addition to that view (a tight-window health strip above
  the existing historical charts) is cheap and complements the webhook
  rather than substituting for it — a webhook can be missed or muted; a page
  someone can check is the thing it degrades to.

## 4. What triggers an alert

Reject "any single agent failing" — too noisy. Per `lineup.ts`'s own
reasoning comment, OpenRouter's free tier is expected to 429 routinely (50
requests/day shared across every free model, which is _why_ the per-model
bench and seat rotation exist at all) and per-model flapping there is normal
operation, not an incident.

Reject pure "fewer than N agents answered in the last race" as the sole
trigger — a single race is one sample; one bad race is well within normal
variance when free-tier models are rotating through rate limits.

**Recommend, over a rolling 15-minute window, two independent conditions —
either fires an alert:**

1. **Core-agent down:** any agent on a fixed "core" allow-list — the ones
   that are paid or otherwise expected to always be available (recommend:
   Anthropic/Claude, DeepSeek, Groq — i.e. every configured non-OpenRouter
   provider, since OpenRouter is explicitly the rotating free tier by
   design) — has **zero successful proposals** across **at least 3 race
   attempts** in the window. The "at least 3 attempts" floor avoids alerting
   during a genuinely quiet 15 minutes with only one race in it; it does
   mean a dead agent during very low traffic takes longer than 15 minutes to
   surface, which is the acceptable cost of not paging on noise. Flag as
   **critical**: this is exactly "dead model / exhausted rate limit / revoked
   key" on a provider that should not be flaky.
2. **Roster-wide shortage:** across _all_ configured agents (core +
   OpenRouter) in the window, average `answered / agents` per race falls
   below **50%**, again with a minimum of 3 races observed. This is the
   "nobody can execute anything" signal distinct from one provider — e.g. a
   shared outage, a market-context failure upstream of every brain call, or
   several providers degrading simultaneously. Flag as **critical** if it
   hits 0% (mirrors the `agents_offline` / `no_agent_answered` responses the
   route itself already returns to users), **warning** at 50%.

Explicitly _not_ a trigger on its own: an individual OpenRouter model's
failure rate, since bench/rotation in `lineup.ts` already absorbs that as
expected behavior. If OpenRouter failures should ever be visible too, make
it a separate low-priority/non-paging signal (e.g. a note in the dashboard
strip, no webhook) rather than folding it into the same threshold — mixing
it in would reintroduce the noise this design is trying to avoid.

Thresholds (3 races, 50%/0%, 15-minute window, 1-hour re-alert debounce) are
starting points to tune after real data is observed, not load-tested
constants — call this out explicitly in the implementation so nobody treats
them as final.

## 5. UI banner (secondary, nice-to-have)

Worth doing, but after the alerting path, and scoped small:

- Only surface the **roster-wide shortage** condition (item 4.2) to end
  users, not individual core-agent failures — a user doesn't need to know
  _which_ provider is down, only that answers may be slow/partial right now.
  Reuse the same 15-minute aggregate the alert check computes rather than a
  second query.
- Render as a dismissible banner, not a blocking state — the route already
  degrades gracefully (fewer cards race, `agents_offline` when the roster is
  empty); a banner should say "agents may be slower or less complete than
  usual" above the compete UI, it should never block submission, since the
  backend's own real-time response (an actual card renders, or an actual
  `agents_offline` error) is always more current and more correct than a
  banner computed from a trailing window.
- Simplest implementation: the same windowed health query exposed as a tiny
  public (no-admin-auth) read, polled client-side at low frequency (e.g. once
  per minute) — not pushed, not real-time, since this is a secondary
  nicety, not safety-critical information.

## Gaps worth closing alongside this (not blocking)

- `failureCode()` in `analytics.ts` maps `no_api_key` and `refused` (both
  real `ProposalOutcome.error` values per `brain.ts`/the brains) into generic
  buckets (`auth` doesn't cover `no_api_key` explicitly — check whether the
  regex `/401|403|api.?key|unauthori[sz]ed|forbidden|auth/i` actually matches
  the literal string `"no_api_key"` it's given — it does, by substring, but
  this is fragile) and `invalid_schema`/`upstream_error` both collapse to the
  catch-all `error` bucket. For a health check that wants to tell "revoked
  key" apart from "provider having a bad day," tightening this mapping (or
  storing the raw `ProposalOutcome['error']` code verbatim instead of
  re-deriving it from a stringified error) would make the alert's own
  `lastFailure` field much more actionable without guessing from a regex.

## Task breakdown

1. **Schema/query:** add a windowed read to `admin-metrics.ts` (or a sibling
   module) that answers the two threshold conditions in section 4 for a given
   `(network, windowMinutes)`, reusing the existing `agent_proposals`/
   `agent_races` join pattern from `agents()`. No new tables needed for this
   part.
2. **Alert-state table/row:** small persistence for "last alerted at" per
   agent/condition, to support debounce and recovered-notice (section 3).
   In Postgres, following the existing `ensureSchema`-on-first-use pattern in
   `analytics.ts`.
3. **Webhook sender:** a small function that POSTs the JSON body in section 3
   to `AGENT_HEALTH_WEBHOOK_URL` if set, with the debounce/recovery logic
   from task 2, and a `console.warn` fallback when unset.
4. **Cron route:** `app/api/cron/agent-health/route.ts` (or similar), `GET`,
   authenticated via bearer `CRON_SECRET` (not the admin-cookie path), wiring
   tasks 1-3 together. Follows the `runtime = 'nodejs'` /
   `dynamic = 'force-dynamic'` conventions already used in
   `compete/route.ts` and `admin/metrics/route.ts`.
5. **`vercel.json`:** add the `crons` entry pointing at the route above.
   Before finalizing the schedule, confirm the `Cookit-Labs` Vercel plan
   supports the desired interval (Hobby is once-daily only; sub-hourly needs
   Pro) and adjust the stated interval/thresholds in section 4 to match
   whatever cadence is actually available.
6. **Env/config:** document `CRON_SECRET` and `AGENT_HEALTH_WEBHOOK_URL` in
   whatever env-var reference the repo keeps (check for a `.env.example` or
   equivalent) and set both in the Vercel project's production env.
7. _(Optional, secondary)_ **Dashboard strip:** extend the existing
   `admin/metrics?view=agents` payload with the windowed figures from task 1,
   and a small UI addition to the admin page that already renders that view.
8. _(Optional, secondary)_ **Public banner:** a small unauthenticated read
   endpoint exposing only the roster-wide shortage boolean/percentage from
   task 1, plus the dapp-side banner component polling it.
9. Ask the user which webhook target they actually have (Slack/Discord/other)
   before task 3 is finalized — the generic `{"text": ...}` body works for
   either untouched, so this only affects whether any vendor-specific
   enrichment is worth adding later.
