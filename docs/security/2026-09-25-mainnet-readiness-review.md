# Internal security review ahead of mainnet

Date: 2026-09-25. Tree reviewed: `main` at `d73ebd5` (the four mainnet-readiness merges, #59–#62, included). Reviewer: internal, code-reading only; no application code changes in this PR.

## Scope and method

The dapp (`apps/dapp`, Next.js 14 API routes and client, `@stellar/stellar-sdk` 17, Postgres via `pg`) was read in this order: every submit route under `app/api` and the assertion each relies on; the fee sponsor; the trade cap and the network flag with its registries; name resolution; abuse controls (rate limits, access gate, sessions, OTP, tick secret, admin); monitoring (`report.ts`, `/api/health`, the low-balance alert); the agent layer; secrets and deploy configuration; dependencies.

The question asked of every submit route was the one the code asks of itself: can a client-controlled signed envelope reach the network through this route while moving value somewhere the user did not ask, or on a venue or network the app did not intend, and does anything trust a body field where it should read the bytes.

Where a finding could be demonstrated, a vitest file was written in the worktree, run, and deleted; its output is quoted under the finding. Paths are relative to `apps/dapp` unless they start with `packages/`. Line numbers are as of `d73ebd5`.

Design choices the plan records as deliberate (the limiter allowing when Postgres is down; `.xlm` names resolved on mainnet whatever the execution network; Blend borrowing out of scope; the API outside the OTP gate) are not reported as bugs. Their consequences are, where they matter for real funds.

## Summary

| ID | Severity | Where | Finding |
| --- | --- | --- | --- |
| C1 | Critical | `package.json` (`next` 14.2.4) | Next.js has a middleware authorization bypass (GHSA-f82v-jwr5-mffw, fixed 14.2.25) and two unauthenticated RCE advisories; the access gate is that middleware and `/_next/image` is live. |
| C2 | Critical | `lib/server/db.ts:22-25`, `lib/sponsor/sponsor.ts:110-116`, `lib/server/rate-limit.ts:199-209` | With no `DATABASE_URL` (the deployed dapp today) the sponsor budget and every rate limit are no-ops; a mainnet sponsor key is drainable at up to 1 XLM per request, by anyone, without an invite. |
| I1 | Important | `lib/swap/plan-validator.ts:65,222-233` | `/api/plan/submit` accepts a lone Soroswap router swap or Blend `submit` whose recipient is a stranger; the per-shape assertions refuse the same bytes, and no plan builder ever emits a contract call. |
| I2 | Important | `app/api/swap/submit/route.ts:34-49`, `plan/submit/route.ts:35-44`, `offers/submit/route.ts:39-48` | `account` is optional; omit it and the re-assertion is skipped and the envelope is broadcast. |
| I3 | Important | `lib/server/health.ts:1,178,186`, `lib/sponsor/balance.ts:1,39` | Health probes and the sponsor balance read testnet Horizon/RPC regardless of the flag; on mainnet the endpoint and the low-balance alert report the wrong network. |
| I4 | Important | `middleware.ts:104`, submit routes | The gate excludes `/api`, so on mainnet the routes that spend the sponsor and build trades need no invite. |
| I5 | Important | `lib/server/rate-limit.ts:228-234`, `.env.example` | The per-IP key is the first `x-forwarded-for` hop; the code assumes Vercel, the deploy is Netlify, and no `netlify.toml` pins the proxy contract. |
| M1 | Minor | `lib/swap/venue-routing.ts:116-131` | `assertSelfSubmission` switches on the raw `AQUARIUS_ROUTER` id rather than the venue-filtered registry; an Aquarius swap is broadcast and sponsored on mainnet where build and plan refuse the venue. |
| M2 | Minor | `lib/perps/order-flow.ts:126-131,212-279` | `assertVenueOn('noether')` runs in prepare only; submit forwards to the gateway on any network. |
| M3 | Minor | `app/api/swap/build/route.ts:128,140`, `lib/swap/assets.ts:79-85` | `slippageBps` is client-controlled up to 10 000 (destMin 0). |
| M4 | Minor | `lib/server/trade-cap.ts:116-176`; all submit routes | The cap is build-time only and per symbol within a plan; a crafted client submits any size, and XLM plus USDC each reach the cap in one signature. |
| M5 | Minor | `app/api/offramp/submit/route.ts:41-51`, `lib/offramp/read-expectation.ts:34-60` | The SEP-10 token is not bound to `account`; a compromised page can pay the anchor for someone else's withdrawal. Destination stays the anchor's, as documented. |
| M6 | Minor | `lib/names/federation.ts:36,52-57,63-66` | SSRF guard is by hostname shape; a public name resolving to a private address passes, and the body cap trusts `content-length`. |
| M7 | Minor | `middleware.ts:58`, `lib/server/session-constants.ts:9` | Edge signature compare is not constant-time; a 7-day session survives revocation of the tester's acceptance. |
| M8 | Minor | `lib/server/health.ts:72-74,151-153`, `app/api/health/route.ts` | `detail` echoes upstream error text (including the `DATABASE_URL` hint); four upstream probes per unauthenticated GET; permanently 503 on the current deploy. |
| M9 | Minor | `lib/server/report.ts:27-37,49-51` | Redaction is by key plus two value rules; a bearer token or JWT inside an error message or a non-secret key survives. Today's callers pass only account/asset/symbol. |
| M10 | Minor | `app/api/perps/session/route.ts:27-44`, `app/api/sponsor/route.ts`, `app/api/health/route.ts` | GET routes are unlimited; `perps/session` GET makes two gateway calls per request. |
| M11 | Minor | `lib/sponsor/fee-bump.ts:51` | 1 XLM per bump against a 50 XLM day: about fifty max-fee submissions from three funded accounts exhaust sponsorship for everyone. |

## Findings

### C1. Next.js 14.2.4 carries a middleware auth bypass and two RCE advisories

Location: `package.json` (`"next": "14.2.4"`); `middleware.ts` (the OTP gate); `components/ui/token-icon.tsx`, `components/apps/venue-card.tsx` (`next/image`); `next.config.js` (no `images` config, so `/_next/image` is served).

What: `pnpm audit --prod` at the workspace root reports, reachable from `apps/dapp > next@14.2.4`:

```
CRITICAL next  >=14.0.0 <14.2.25   patched >=14.2.25  GHSA-f82v-jwr5-mffw  Authorization Bypass in Next.js Middleware
CRITICAL next  >=10.0.0 <15.5.24   patched >=15.5.24  GHSA-2xp9-vwfh-vxw4  Unauthenticated RCE in Image Optimization API
CRITICAL next  >=13.4.0 <15.5.24   patched >=15.5.24  GHSA-p293-qw3h-jr36  Unauthenticated RCE on windows-hosted servers
HIGH     next  >=9.5.5  <14.2.15   patched >=14.2.15  GHSA-7gfc-8cq8-jh5f  authorization bypass
HIGH     next  >=14.0.0 <14.2.10   patched >=14.2.10  GHSA-gp8f-8m3g-qvj9  cache poisoning
(plus eight DoS/SSRF advisories, all patched in 14.2.34–15.5.21)
90 vulnerabilities found: 6 low | 47 moderate | 34 high | 3 critical
```

Why it matters: the access gate that the plan turns on for mainnet is exactly the middleware GHSA-f82v-jwr5-mffw bypasses with one request header. Netlify and Vercel announced edge mitigations for that CVE, but a hosted mitigation is not something to bet real funds on. The image optimizer is live in this app and the advisory names it as unauthenticated RCE on the server that holds `SPONSOR_SECRET_KEY`.

Smallest fix: `next` to the latest 14.2.x (≥ 14.2.35 clears every 14-line advisory above except the two RCEs), and `images: { unoptimized: true }` in `next.config.js` until the app is on 15.5.24+. Re-run `pnpm audit --prod` in CI and fail on critical.

Verified: audit output above; `grep -rl "from 'next/image'"` finds two components; `next.config.js` has no `images` block.

### C2. With no database, the sponsor has no budget and the app has no rate limits

Location: `lib/server/db.ts:22-25` (`getPool` throws when `DATABASE_URL` is unset); `lib/sponsor/sponsor.ts:100-126` (`commitToBudget` catches everything and returns `true`), `:187-194`; `lib/server/rate-limit.ts:179-210` (`checkRateLimit` catches and allows), `:243-263`.

What: both stores treat "no database configured" the same as "database unreachable". The plan records the limiter's fail-open as deliberate for a blip; the deployed dapp has no `DATABASE_URL` at all, so it is permanently open. The budget (`SPONSOR_DAILY_BUDGET_XLM`, `SPONSOR_DAILY_PER_ACCOUNT`) is likewise never consulted, including a budget of zero, which `.env.example` documents as the way to switch sponsorship off.

Why it matters: on mainnet with a funded `SPONSOR_SECRET_KEY`, anyone with a funded Stellar account (1 XLM reserve) can sign a self-directed transaction with an inner fee of 0.5 XLM and post it to any submit route as fast as the functions answer; the sponsor pays up to 1 XLM per request (`fee-bump.ts:51,88-96`) until it is empty. No invite is needed (I4) and no per-IP or per-account limit applies. The inner transaction does not even need to succeed on chain: a fee-bump that reaches a ledger is charged whether the inner operation fails or not.

Smallest fix: in `sponsorForSubmission`, treat a missing `DATABASE_URL` as `sponsored: false, reason: 'no_ledger'` (distinguish "not configured" from "unreachable" — the former is a deployment error, the latter a blip). Set `DATABASE_URL` on the mainnet deploy; without it there are also no sessions, rules, alerts or limits. Consider the same distinction in `checkRateLimit`, and a `GET /api/health` that goes red when the sponsor is configured without a ledger.

Verified with a temporary test (deleted before commit), `SKIP_LIVE=1 npx vitest run`:

```
✓ F1 > sponsors with SPONSOR_DAILY_BUDGET_XLM=0 when the ledger has no database
✓ F1 > enforceRateLimit allows every request when the limiter has no database
```

The first calls `sponsorForSubmission` with `DATABASE_URL` deleted, `SPONSOR_DAILY_BUDGET_XLM: '0'`, `SPONSOR_DAILY_PER_ACCOUNT: '0'`, a stubbed Horizon that knows the sponsor, and no injected ledger; it returns `sponsored: true` and logs `[sponsor-ledger] database unreachable, sponsoring without a budget`. The second sends 25 POSTs from one address and one account through `enforceRateLimit(request, 'submit', account)`; all 25 are allowed against a limit of 10.

### I1. `/api/plan/submit` admits contract calls that pay a stranger

Location: `lib/swap/plan-validator.ts:54-70` (`ALLOWED_OPERATIONS` includes `invokeHostFunction`), `:208-216` (destination checked for path payments only), `:222-233` (a contract call is checked by contract id and function name via `labelForCall`, never by its arguments); `lib/swap/contract-registry.ts:169-246` (Soroswap router `swap_exact_tokens_for_tokens`, Aquarius `swap`, aggregator, Blend `submit`, Noether `open_position` all listed); `app/api/plan/submit/route.ts:37`.

What: a single-operation envelope calling the Soroswap router with a stranger in the `to` argument, or Blend's `submit(from=user, spender=user, to=stranger, [withdraw])`, passes `assertSelfPlan`. The same bytes are refused by `assertSelfSubmission` (`venue-routing.ts:104-132`) and `assertSelfWithdraw` (`lend/blend-client.ts:331-392`), which read the recipient argument. `build-plan.ts:171-237` never emits an `invokeHostFunction`; the allowlist entry admits a shape no plan builder produces. The registry comment at `contract-registry.ts:211-219` says the Blend label is accurate "because the only path that reaches this table is a plan step and `build-plan` builds supplies only" — true of the builder, not of the submit route.

Why it matters: the submit-time re-assertion exists for exactly one adversary — something between build and broadcast that alters bytes and picks the endpoint (a compromised page, an extension). On this route that adversary gets a Blend withdrawal of the whole position, or a router swap, paid to an address of its choosing, and the sponsor pays the fee. It needs the user's signature, which the app's own UI never asks for, so this is a hole in defence in depth rather than a direct theft path; it is the one route where the guarantee the codebase repeats in every builder comment does not hold.

Smallest fix: remove `invokeHostFunction` from `ALLOWED_OPERATIONS` (no plan contains one), or dispatch each `invokeHostFunction` step to the per-contract argument assertion (`assertSelfSoroswapSwap`, `assertSelfAquariusSwap`, `assertSelfPoolCall`) before accepting it.

Verified with the temporary test:

```
✓ F2 > assertSelfPlan accepts a lone Soroswap router swap whose `to` is a stranger; assertSelfSubmission refuses it
✓ F2 > assertSelfPlan accepts a Blend `submit` that withdraws the whole position to a stranger; the lend route assertion refuses it
```

The Blend case is described by `assertSelfPlan` as `['Supply to Blend']`.

### I2. `account` is optional on the swap, plan and offer submit routes

Location: `app/api/swap/submit/route.ts:34-49` (assertion only `if (typeof body.account === 'string' && body.account !== '')`), `:54-56`; `app/api/plan/submit/route.ts:35-44`; `app/api/offers/submit/route.ts:39-48`. Contrast `app/api/lend/submit/route.ts:50-56`, `send/submit/route.ts:48-52`, `offramp/submit/route.ts:41-45`, which require it.

What: without `account` the route decodes nothing and posts the bytes to Horizon. The sponsor does not pay in that case (`fee-bump.ts:81` refuses `source_mismatch` against `''`), so the exposure is the broadcast, not the fee.

Why it matters: the same tamperer I1 is written against can drop one JSON field to skip the check entirely, so the re-assertion is opt-in for the party it is meant to stop. The app then broadcasts, and records in its own logs, a transaction it would have refused.

Smallest fix: three lines per route: `account` required, as the lend route already does.

Verified with the temporary test, which imports the route with `submitSignedSwap` mocked and `DATABASE_URL` unset:

```
✓ F3 > /api/swap/submit skips the re-assertion when `account` is omitted > broadcasts an envelope that pays a stranger
```

A payment to a stranger signed by the user is submitted (200, the mock receives the XDR); the same body with `account` set is refused (400).

### I3. Health and the sponsor balance read testnet regardless of the network flag

Location: `lib/server/health.ts:1` (imports `stellarTestnet`), `:178` (Horizon probe), `:186` (RPC probe); `lib/sponsor/balance.ts:1,39` (`stellarTestnet.horizonUrl`). Every other consumer was moved to `stellarNetwork` (`git grep stellarTestnet apps/dapp` outside tests returns only these five lines).

What: on a mainnet deployment `GET /api/health` reports testnet Horizon and RPC health under `network: 'mainnet'`, and `readSponsorBalance` (used by the health `sponsor` check and by the daily low-balance alert in `standing-tick.ts:102-133`) reads the sponsor's testnet account. A key never used on testnet reads as `funded: false, balanceXlm: '0'`; one that was friendbotted there reads a balance that has nothing to do with the funds paying real fees.

Why it matters: the low-balance alert is the only operator signal the plan adds for the sponsor. On mainnet it either fires every day at "0" or never fires while the real account drains.

Smallest fix: `stellarNetwork` in both files. `readSponsorBalance` already takes `horizonUrl` as an option, so the tests need no change.

Verified: by reading; the grep above.

### I4. The access gate does not cover the routes that spend money

Location: `middleware.ts:104` (`matcher` excludes `api`, by design: "the API answers with its own checks"); every route under `app/api/*/submit` and `*/build` performs no session check; `lib/server/session.ts:82-100` (`readSessionFromRequest`) exists and is used only by the standing routes.

What: on mainnet, `ACCESS_GATE` defaults to on (`lib/server/access-gate.ts:17-22`) and stands in front of the pages only. Anyone can call `/api/swap/build` and `/api/swap/submit` directly, and the sponsor pays their fees; the OTP gate limits who sees the UI, not who uses the key.

Why it matters: C2's drain and M11's griefing need no invite, and the per-account limits in the budget are keyed on Stellar accounts, which are free to create. The "door" the plan describes is not in front of the sponsor.

Smallest fix: when the gate is on, require a valid session (`readSessionFromRequest`) in the submit routes, or at least in `sponsorForSubmission` (sponsor only sessions; unsponsored submission can stay open). Tie the per-account sponsor count to the session email as well as the Stellar account.

Verified: by reading; `route-rate-limit.test.ts` enumerates the 32 POST routes and none reads a session except `standing` and `standing/inbox`.

### I5. The rate-limit key trusts the first `x-forwarded-for` hop; the deploy is not the platform the code assumes

Location: `lib/server/rate-limit.ts:212-234` (`clientIp` takes `split(',')[0]`; the comment says "This deployment's proxy is assumed to write it" and names Vercel); `.env.example` (same assumption in the rate-limit paragraph). There is no `netlify.toml` in the repository, so nothing pins the proxy contract.

What: behind a proxy that appends rather than overwrites, a client picks its own bucket by sending the header. Netlify's documented trustworthy client address is `x-nf-client-connection-ip`.

Why it matters: the per-IP limit is the only control that does not need a Stellar account to defeat. Once C2 is fixed this is what bounds the sponsor per caller.

Smallest fix: read `x-nf-client-connection-ip` first when present, then the existing chain; commit a `netlify.toml` so the assumption is in the repo.

Verified with the temporary test:

```
✓ F5 > the limiter keys on the first x-forwarded-for hop > a client-supplied first hop becomes the bucket
```

`x-forwarded-for: 10.0.0.1, 198.51.100.7` keys as `10.0.0.1`.

### M1. Aquarius is refused at build and plan on mainnet but admitted at submit

Location: `lib/swap/venue-routing.ts:7,116-131` (switches on `AQUARIUS_ROUTER`, `SOROSWAP_ROUTER`, `SOROSWAP_AGGREGATOR` constants); `lib/swap/contract-registry.ts:106-109` (Aquarius has a mainnet id), `:255-257` (`ENTRIES` filters by `venueIdOn`, so `lookupContract` excludes it on mainnet); `lib/venues.ts:121-132` (Aquarius has no `networks`, so testnet only).

What: a self-paying Aquarius `swap` on mainnet passes `assertSelfSubmission` and is broadcast and sponsored, while `buildAquariusSwap` (`build-aquarius.ts:105`) and `assertSelfPlan` refuse the venue. Value stays with the user; the venue gate is inconsistent.

Fix: in `assertSelfSubmission`, resolve the contract through `lookupContract` and refuse ids it does not return.

### M2. Perps submit is not venue-gated

Location: `lib/perps/order-flow.ts:126-131` (`assertVenueOn('noether')` in `prepareOrder` only); `:212-279` (`submitOrder` reads the gateway and forwards).

What: on a mainnet deployment a testnet-signed Noether envelope with matching arguments is forwarded to the testnet gateway. No mainnet value moves; the "not on mainnet" property holds only for the half of the flow that has the check.

Fix: the same `assertVenueOn` call at the top of `submitOrder`.

### M3. Slippage tolerance is client-controlled up to 100 %

Location: `app/api/swap/build/route.ts:128,140` (`body.slippageBps` passed through when it is a number); `lib/swap/assets.ts:79-85` (`applySlippage` accepts 0–10 000); `lib/swap/build-tx.ts:104,118`.

What: `slippageBps: 10000` yields `destMin` of zero on the classic path, a swap the network will fill at any price. The UI does not offer it; a tampered request does.

Fix: clamp to a server-side maximum (a few hundred bps) and refuse above it.

### M4. The trade cap is a build-time control, per symbol within a plan

Location: `lib/server/trade-cap.ts:97-107,116-176`; `app/api/swap/build/route.ts:124-134`; no submit route consults it.

What: the cap is checked on a fresh server-side quote (sound, including the widened `sendMax` on strict-receive), but a client that builds its own envelope submits any size, and `assertPlanWithinCap` sums per symbol, so a plan spending $50 of XLM and $50 of USDC passes a $50 cap. Since the cap protects the user from the app and not the sponsor from the user, this is a note rather than a hole; it is worth knowing the cap does not bound what the sponsor pays fees for.

Fix: sum across symbols in `assertPlanWithinCap`; if the cap is meant to bound sponsorship, value the envelope at submit before wrapping.

### M5. The offramp submit cannot tell whose withdrawal it is paying for

Location: `app/api/offramp/submit/route.ts:41-51,75`; `lib/offramp/read-expectation.ts:34-60`; `app/api/offramp/build/route.ts:14-16` (documents that a compromised page "can ask for the wrong withdrawal id; it cannot name a destination").

What: `transactionId` and `authToken` come from the body; the anchor answers for whichever withdrawal the token owns, and the payment (destination the anchor's pooled account, memo the withdrawal's) is asserted against that answer. A page holding an attacker's SEP-10 token and withdrawal id can have the user pay for the attacker's cash pickup. The destination check holds as documented; the attribution does not.

Fix: SEP-10 tokens are JWTs whose `sub` is the account (optionally `account:memo`); decode without verifying and refuse when `sub` does not start with `account`.

### M6. Federation SSRF guard is by hostname shape

Location: `lib/names/federation.ts:36,52-57` (`isPublicHost`), `:59-61` (`redirect: 'error'`, 10 s timeout), `:63-66` (`tooLarge` checks `content-length` only).

What: sound against loopback, IP literals, reserved suffixes and redirects. A public hostname whose A record is a private address passes, and a chunked body of any size is read before the 64 KiB slice. On Netlify functions there is little internal network to reach, so the residual is small.

Fix: resolve the host and refuse private ranges before fetching, or read the body with a bounded reader.

### M7. Edge session compare and session lifetime

Location: `middleware.ts:58` (`expected !== signature`; the Node path at `lib/server/session.ts:63` uses `timingSafeEqual`); `lib/server/session-constants.ts:9` (7 days); `app/api/auth/verify-otp/route.ts:28-31` (acceptance re-checked at issuance only).

What: a rejected tester keeps page access until the cookie expires; the edge compare leaks timing in principle. Both are small on an OTP gate that fronts a UI, not funds (I4).

Fix: a constant-time compare on the edge (XOR over the bytes); a shorter TTL, or a revocation check against the waitlist on a cheap cadence.

### M8. Health endpoint disclosure and cost

Location: `lib/server/health.ts:72-74,100-101` (`detail: reason(e)` echoes upstream error text), `:167-203` (four probes per call); `app/api/health/route.ts:17-23` (unauthenticated, uncached).

What: `detail` today includes `DATABASE_URL is not set. Run docker compose up -d and check .env.local` and Horizon/RPC status lines; the sponsor address is public by design. Four upstream requests per unauthenticated GET is a cheap amplifier against Horizon and the RPC. On the current deploy (no database) the endpoint is permanently 503, which trains operators to ignore it.

Fix: map failures to fixed strings; a short cache or a shared secret for the full body.

### M9. Redaction is key-based with two value rules

Location: `lib/server/report.ts:27-37` (key regex, seed regex, email regex), `:49-51` (`scrubText` applies only the seed and email rules to values), `:101-107` (`scrubbedError` copies name, message and stack; `cause` and custom properties are dropped, which is the safe direction).

What: a bearer token, a SEP-10 JWT or an API key inside an error message, a URL, or under a key that does not match the regex (`url`, `body`, `detail`) is forwarded as is. Nested arrays are walked correctly (`redactValue` maps arrays). Today's eight call sites pass `account`, `asset`, `sellSymbol`, `buySymbol` only, so nothing leaks now; the module will be handed richer contexts.

Fix: value rules for `Bearer …` and JWT-shaped strings, and a test that the `NoetherHttpError` and anchor error messages survive scrubbing without their bodies.

### M10. GET routes are outside the limiter

Location: `app/api/perps/session/route.ts:27-44` (two gateway calls per GET), `app/api/sponsor/route.ts`, `app/api/health/route.ts`, `app/api/offers/route.ts`, `app/api/standing/route.ts` GET.

What: the limiter is applied as the first statement of every POST route (confirmed by `route-rate-limit.test.ts`, 32 routes); GETs that fan out to third parties are not. Cost, not correctness.

Fix: `enforceRateLimit` on the GETs that call out.

### M11. Per-bump cap versus daily budget

Location: `lib/sponsor/fee-bump.ts:51` (`DEFAULT_MAX_FEE_STROOPS` 1 XLM), `:88-96`; `lib/sponsor/budget.ts:13-14` (50 XLM, 20 per account).

What: with the budget working, about fifty submissions at the cap from three funded accounts spend the day's 50 XLM and switch sponsorship off for everyone else. A classic operation costs 100 stroops; 1 XLM is a Soroban-sized ceiling applied to every shape.

Fix: cap by shape — a low ceiling for classic envelopes, the 1 XLM one only when the inner transaction carries Soroban data.

## Checked and sound

Submit-time assertions, one per shape, each reading the bytes rather than the body:

- Classic swap: `assertSelfSwap` (`build-tx.ts:168-199`) requires one operation, a path payment, `destination === account`, `tx.source === account`, refuses fee bumps. Operation-level `source` is not checked, but a different operation source would need that account's signature, so it cannot move the signer's funds.
- Soroswap and aggregator: `assertSelfSoroswapSwap` (`build-soroban.ts:230-281`) checks function name, arity by layout, and the recipient argument (4th of 5 on the router, 6th of 7 on the aggregator); `assertAggregatorSwap` (`build-aggregator.ts:310-342`) additionally checks contract id against the quote and the registry, assets in and out, amount in, floor within the slippage band and not above the quote, every distribution leg's endpoints, the deadline, and operation source; and the route re-runs it on the bytes that come back from simulation (`swap/build/route.ts:343-353`).
- Aquarius: `assertSelfAquariusSwap` (`build-aquarius.ts:188-254`) checks `swap` by name (refusing `swap_chained`), seven arguments, `user` first argument equal to the signer, and a 32-byte pool index.
- Blend: `assertSelfPoolCall` (`lend/blend-client.ts:331-392`) checks `submit`, four arguments, and that `from`, `spender` and `to` are all the signer; `kind` in the body chooses only the wording (`lend/submit/route.ts:32-34,67-77`).
- Pools and offers: `assertSelfPoolOp` (`build-pool.ts:257-282`) and `assertSelfOffer` (`build-offer.ts:184-218`) require a lone operation, sourced by the account, of a shape that has no destination field.
- Offramp: `assertOfframpPayment` (`offramp/build-payment.ts:193-243`) checks payment type, operation source, destination, asset code and issuer (the active network's USDC), amount in stroops and memo against an anchor read made by the server at both build and submit; the anchor is an allowlist with a pinned SEP-10 signing key per network (`anchors.ts:47-68,98-111`).
- Send: `assertSendPayment` (`send/build-payment.ts:133-202`) checks the same fields against a resolution the server performs again at submit (`send/submit/route.ts:59-77`), refuses payment to self, and refuses a memo nobody named or a missing one somebody did; only `G…` accounts are payable (`names/resolve.ts:48-56`).
- DeFindex: `assertDefindexDeposit` (`defindex/deposit.ts:72-131`) pins vault (resolved server-side at submit), function, amount, floor, `from` and the invest flag.
- Perps: `assertPerpOrder` (`perps/assert-order.ts:126-223`) pins source, contract (resolved from the gateway at both prepare and submit), function, every argument, and refuses any auth entry other than `source_account`.
- Which assertion applies is decided from the bytes, not from a venue the client names (`venue-routing.ts:104-132`).

Fee sponsor (`sponsor.ts`, `fee-bump.ts`, `budget.ts`, `sponsor-ledger.ts`), with a database present: the inner transaction must be sourced by and signed by `account` (`fee-bump.ts:81-82`, hint plus verify); already-bumped envelopes are refused; the outer fee is derived from the inner and capped; the sponsor signs only the outer envelope, so no inner operation (a `setOptions` or `beginSponsoringFutureReserves` naming the sponsor) can carry its authority; the bumped XDR is submitted server-side and never returned to the client; budget is reserved before judging and released on refusal in one statement with `RETURNING`, so two racers each see their own total (`sponsor-ledger.ts:90-115`); an over-count on a Horizon rejection stays over-counted, the safe direction; friendbot is never called on mainnet (`sponsor.ts:144-146`); a `'*'` collision in the ledger statement is unreachable because `account` must be a valid signer before it reaches the ledger. The fallback-to-unsponsored path sends the user's own signed bytes with their own fee, unchanged.

Trade cap: enforced on a fresh server-side quote for every mainnet venue, never on the client's figure (`swap/build/route.ts:124-134,175-185,215,309,401`); strict-receive caps the widened `sendMax`; send caps the sized amount; offers cap the selling side; offramp caps the anchor's amount; a plan is capped per step and then per symbol; an unpriced asset is refused rather than estimated (`trade-cap.ts:57-61,75-83`). The lend, borrow, repay, collateral and DeFindex routes carry no cap and need none while their venues are testnet-only; each builder calls `assertVenueOn` first (`venues.ts:326-330`), and the route comments say to add the cap before the venue gains `mainnet`.

Network flag: `NEXT_PUBLIC_STELLAR_NETWORK` is parsed once at import and anything but `testnet`/`mainnet`/unset throws (`packages/config/src/stellar.ts:22-34`). The bracket form `process.env['NEXT_PUBLIC_STELLAR_NETWORK']` the comment relies on is inlined: a build through Next 14.2.4's bundled webpack with `DefinePlugin({'process.env.NEXT_PUBLIC_STELLAR_NETWORK': '"mainnet"'})` turned `exports.a = process.env["NEXT_PUBLIC_STELLAR_NETWORK"]` into `exports.a = "mainnet"` (a concatenated key was left alone, as expected), and `@intent/config` is in `transpilePackages` (`next.config.js:5`), so the client bundle carries the build-time value and the server reads the same variable; a mismatch would fail closed, since the wallet's passphrase is compared with `stellarNetwork.networkPassphrase` (`lib/wallet-network.ts:13-15`) and a transaction signed for the other network fails signature verification. Contract ids are `{testnet, mainnet}` pairs with mainnet `undefined` where unverified (`contract-registry.ts:54-153`), and the allowlist is further filtered by venue (`:255-257`); Reflector oracles follow the flag (`prices/reflector.ts`); assets carry `networks` and the unverified tier throws on mainnet (`asset-registry.ts:162-164`, `testnet-assets.ts:57-67`); anchors are per network with MoneyGram production only when its domain is configured and its pinned production key matches (`anchors.ts:86-130`); USDC is the active network's issuer everywhere (`STELLAR_USDC`). The one place a testnet id reaches a mainnet decision is M1.

Names: `.xlm` is resolved on the mainnet registry by design, subdomains require the second slot rather than falling back to the parent (`soroban-domains.ts:106-119`), and `assertCanReceive` checks the account exists and holds the asset on the active network before building (`send/prepare.ts:111-141`). Federation is https-only, no redirects, bounded, memo types restricted to the three the network has, `account_id` validated as a public key, memo required to be a string (`federation.ts:135-157`). The address book is browser-only and "decides nothing" (`address-book.ts:18-21`), and the server resolves again at submit.

Abuse controls: every POST route calls `enforceRateLimit` before reading its body (`route-rate-limit.test.ts`, 32 routes); overrides that fail to parse keep the default (`rate-limit.ts:51-60`); oversized header values are ignored rather than allowed to break the key. The tick refuses to run without a secret of at least 16 characters and compares it in constant time (`standing/tick/route.ts:30-38,63-74`); the admin token likewise (`admin/waitlist/route.ts:15-23`). OTP codes are CSPRNG, stored hashed, five attempts, one-minute cooldown, five sends an hour, compared in constant time (`otp.ts:45-127`); acceptance is re-checked at verification; the waitlist route never reveals status. Sessions are HMAC-SHA256 over a compact payload with no algorithm field, `httpOnly`, `secure` in production, `sameSite: lax` (`session.ts:32-43,102-110`); the middleware fails closed in production without a secret (`middleware.ts:80-82`).

Monitoring: `reportError` redacts by key (`secret|token|password|passphrase|xdr|cookie|authorization|api.?key|private|seed|mnemonic|signature`), scrubs seeds and masks emails in every string including messages and stacks, walks nested objects and arrays, and drops `cause` and custom properties from the copy sent to Sentry; Sentry is inert without a DSN, `tracesSampleRate` 0.1, no replay, no PII option, no source-map upload (`sentry.*.config.ts`, `next.config.js:51-55`). The alert fires once per UTC day via `alerts_sent` and never when `ALERT_EMAIL` is unset (`standing-tick.ts:108-133`).

Agents: every value crossing into a prompt goes through `promptSafe` (one line, control characters stripped, capped; `prompt-safe.ts:21-27`, `brains/openai-compatible.ts:184-199,274-276`); every response is validated by the zod schema and then by range, route allowlist and venue allowlist regardless of strict mode (`tool-schema.ts:134-177,237-356`); a route id outside the offered set fails the proposal, a resting price is clamped to the book and refused if it would cross (`:417-487`); the plan builder emits classic operations only and the agent's numbers are overwritten by measured ones (`brain.ts:203-210`). There is no field in the proposal schema through which an agent can name a destination, contract or amount to sign.

Secrets and configuration: every `NEXT_PUBLIC_` variable in `.env.example` is public-safe (URLs, the network flag, the UI flag, the client Sentry DSN); every key (`SPONSOR_SECRET_KEY`, `AUTH_SECRET`, `ADMIN_TOKEN`, `STANDING_TICK_SECRET`, provider and API keys) is server-only, and `packages/config/src/env.ts:17-25` says so. The bundle reads the network through `@intent/config` only.

Dependencies: `@stellar/stellar-sdk` 17.0.1 is pure JavaScript (`@noble/ed25519`, no `sodium-native`, `axios` pinned at the patched 1.18.0); `pg` 8.23 without `pg-native`; `ioredis` 6; `@sentry/nextjs` 11 with telemetry off; `openai` 7.10; `zod` 3.25. The install without lifecycle scripts works, so no package in the runtime path needs a build step. The EVM wallet stack (`wagmi`, `@rainbow-me/rainbowkit`, `viem`, `@creit.tech/stellar-wallets-kit`) accounts for most of the 34 high advisories (`hono` CORS, `socket.io-parser`, `ws`, `form-data`, `axios`); they run in the browser, and shipping the Arc stack in a Stellar mainnet bundle is a surface worth questioning.

## Mainnet go/no-go

Not yet. Nothing in the trading and assertion layer was found that moves a user's funds without a signature the app's own UI never requests, and the sponsor design is sound when its ledger exists. What blocks the flag is the environment around it.

Must change before `NEXT_PUBLIC_STELLAR_NETWORK=mainnet` with real funds:

1. C1: upgrade `next` (≥ 14.2.35 at least) and disable the image optimizer until on 15.5.24+; add `pnpm audit --prod` to CI with a critical threshold.
2. C2: give the deployment a `DATABASE_URL`, and make `sponsorForSubmission` refuse to sponsor when none is configured. Without this, the budget, the per-account count and every rate limit are prose.
3. I4: put the sponsor behind the session when the gate is on, so a mainnet fee is paid only for an invited tester.
4. I3: `stellarNetwork` in `health.ts` and `balance.ts`, so the one alert the sponsor has reads the right ledger.
5. I5: read Netlify's client address header first and commit a `netlify.toml`.
6. I1 and I2: remove `invokeHostFunction` from the plan allowlist (or dispatch to the argument assertions) and make `account` required on every submit route. Small, and the assertion layer is the app's whole security story.

Should change soon after: M1 and M2 (venue gating at submit for Aquarius and Noether), M3 (server-side slippage ceiling), M11 (a classic-sized fee cap), M5 (bind the SEP-10 token to `account`), M8 (fixed health `detail` strings), M4 (sum the plan cap across symbols), M9 (value rules for tokens in `report.ts`), M6, M7, M10.

What an external auditor should look at first: the fee-bump wrapper and budget under concurrency against a real Postgres (`fee-bump.ts`, `sponsor.ts`, `sponsor-ledger.ts`), including whether a fee-bump for an inner transaction that fails on chain can be induced cheaply at scale; `assertAggregatorSwap` and `assertSelfPlan`, the two assertions that admit bytes built elsewhere or several operations at once; the Soroban argument layouts pinned by position (`build-soroban.ts:259`, `build-aquarius.ts:231-253`, `blend-client.ts:373-391`) against the deployed mainnet contracts' current interfaces; and the browser side of signing (how the wallet prompt presents a plan, and whether anything in the client can alter `signedXdr` or the body between review and POST), which this review did not cover.
