# Mainnet readiness

**Goal:** the dapp can be pointed at Stellar mainnet by configuration, behind a flag, with small per-trade caps, abuse controls, a sponsor budget, health and error reporting, and a test suite that runs in CI including a browser smoke pass. Nothing about trading logic or the assertion layer changes.

**Shape:** four independent slices (M1–M4), each its own branch and PR, each with tests written first. M1 is the foundation the others assume the _names_ of (`stellarNetwork`, `activeNetwork()`), so M2–M4 must not touch `packages/config/src/stellar.ts` or `lib/swap/contract-registry.ts`; they read the active network through the helper M1 adds, or through `process.env['NEXT_PUBLIC_STELLAR_NETWORK']` with `'testnet'` as the default if the helper is not merged yet.

**Repo facts (verified 2026-09-24):**

- `packages/config/src/stellar.ts` exports `stellarTestnet` (passphrase, `horizonUrl`, `sorobanRpcUrl`, `friendbotUrl`, `blockExplorerUrl`, `freighterNetwork`), `STELLAR_USDC` (Circle's **testnet** issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) and `stellarDescriptor`. 46 source files in `apps/dapp` import `stellarTestnet`.
- Circle's **mainnet** USDC issuer is `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. Mainnet passphrase `Public Global Stellar Network ; September 2015`, Horizon `https://horizon.stellar.org`, RPC `https://mainnet.sorobanrpc.com`, explorer `https://stellar.expert/explorer/public`, Freighter label `PUBLIC`. No friendbot on mainnet.
- `apps/dapp/lib/swap/contract-registry.ts` pins testnet ids: `SOROSWAP_ROUTER`, `SOROSWAP_AGGREGATOR`, `AQUARIUS_ROUTER`, `BLEND_POOL`, `NOETHER_MARKET`, `NOETHER_ROUTER`; `lib/prices/reflector.ts` pins `REFLECTOR_CEX_DEX` and `REFLECTOR_FX` (testnet). `lookupContract(id)` is the allowlist every builder consults.
- `lib/venues.ts` lists venues with `integration: 'executes' | 'quotes' | 'listed'`; `lib/agents/market-context.ts` filters the list the agents see.
- `lib/offramp/anchors.ts`: `testanchor` (testnet only) and `moneygram` (`extstellar.moneygram.com`, testnet deployment; production needs a commercial agreement).
- `lib/sponsor/sponsor.ts`: `sponsorForSubmission` funds an unfunded sponsor through friendbot on a Horizon 404, caps each fee at 1 XLM (`fee-bump.ts`), never fails a submission (falls back to unsponsored with a `reason`).
- Postgres: `lib/server/db.ts` `getPool()`; migrations in `packages/db/migrations/00N_*.sql`; `lib/server/standing-rules.ts` shows the lazy-DDL pattern (`CREATE TABLE IF NOT EXISTS` on first use, cached promise on `globalThis`) and `lib/__tests__/fakes/standing-rules-db.ts` the in-memory fake query function used by its tests.
- `lib/server/email.ts`: `EmailSender` with console and Resend implementations (`RESEND_API_KEY`, `EMAIL_FROM`).
- `lib/server/standing-tick.ts` `runTick` runs from `POST /api/standing/tick` guarded by `STANDING_TICK_SECRET`; a scheduler calls it.
- `middleware.ts` has `matcher: []` (the OTP access gate is switched off); the gate itself, `/verify`, sessions and OTP still work.
- Redis (`REDIS_URL`) is used only by `lib/server/otp.ts`. Everything else is Postgres.
- `.github/workflows/ci.yml` runs `pnpm typecheck`, `pnpm lint`, `pnpm build` on PRs and pushes to main. **It does not run `pnpm test`.** Root `package.json` has `"test": "turbo run test"`; the dapp's is `vitest run`.
- `AGENT_BRAIN=mock` gives deterministic agents without any LLM key (`packages/config/src/env.ts`).
- Existing tests: 1527 in `apps/dapp` with `SKIP_LIVE=1`; live tests are `*.live.test.ts`.

## Global constraints

- Own branch per slice, in the worktree you were given. Commit as you go; do not push.
- commitlint: header ≤ 100 chars, lowercase after the type; no co-author lines; lint-staged runs eslint --fix and prettier on staged ts/tsx.
- Tests first, watched failing. Logic in `lib/`; routes and components thin. Vitest is node-only.
- Write files with the Write tool (backslashes are eaten in heredocs). Keep a file's line endings. Bash cwd resets between calls.
- Before finishing: `SKIP_LIVE=1 npx vitest run` green, `npx tsc --noEmit -p .`, `pnpm exec next lint`, `prettier --check` on touched files.
- No new features beyond the slice. Comments say why, in the voice of the existing code.

---

## M1 — Network abstraction and the mainnet flag

**Owner: worker A. Branch `feat/mainnet-network`.**

1. `packages/config/src/stellar.ts`: keep the shape, add a second object for mainnet, and export `stellarNetwork` chosen by `NEXT_PUBLIC_STELLAR_NETWORK` (`'testnet'` default, `'mainnet'` the only other value; anything else throws at import with a clear message). Keep `stellarTestnet` exported as before (it is the testnet object) **and** make every consumer read the active network: codemod the 46 imports from `stellarTestnet` to `stellarNetwork` (mechanical; `git grep -l stellarTestnet apps/dapp | xargs sed -i 's/stellarTestnet/stellarNetwork/g'` then review the diff for places that meant testnet specifically, such as friendbot). `friendbotUrl` is optional and absent on mainnet. `STELLAR_USDC` becomes per-network too (`stellarNetwork.usdc`), with `STELLAR_USDC` kept as the active network's for the same reason. `stellarDescriptor.networkLabel` reads "Stellar mainnet" / "Stellar testnet". Add `export function isMainnet(): boolean`.
2. Contract registry per network: `contract-registry.ts` keeps the same exported names but each resolves from a `{ testnet, mainnet }` table for the active network. Mainnet ids: **look each one up from the venue's own docs or deployment repo and cite the source in a comment beside the id** (Soroswap router and aggregator from soroswap.finance docs / github soroswap; Aquarius router from aqua.network docs; Blend from blend.capital docs, the main USDC pool; Reflector mainnet oracles from reflector.network docs). If an id cannot be verified from a primary source, do not guess: leave it `undefined` for mainnet and the venue becomes unavailable there. `lookupContract` and `labelForCall` work per network.
3. Venue availability: `Venue` (in `packages/types`) gains `networks?: ('testnet' | 'mainnet')[]` (absent = testnet only). `lib/venues.ts` marks Soroswap, StellarX (SDEX), Stellar liquidity pools and Soroban Domains as `['testnet', 'mainnet']` and everything else testnet only for launch. `market-context.ts` filters the agents' venue list by the active network; the Apps page shows an unavailable-here venue with a quiet "Not on mainnet yet" label instead of Integrated. Quote sources (`lib/swap/quote.ts` and the sources) skip venues not on the active network.
4. Anchors per network: `AnchorEntry` gains `networks`; `testanchor` testnet only; `moneygram` testnet only unless `MONEYGRAM_PRODUCTION_HOME_DOMAIN` is set, which then supplies the production domain. On mainnet with no anchor, offramp intents are refused with "no fiat off-ramp is configured on mainnet yet".
5. Sponsor: friendbot only when `stellarNetwork.friendbotUrl` is defined; on mainnet an unfunded sponsor yields `sponsored: false, reason: 'sponsor unfunded'`.
6. Per-trade cap on mainnet: `lib/server/trade-cap.ts` `assertWithinCap(usd: number)` reading `MAINNET_MAX_TRADE_USD` (default `50`), no-op on testnet. Applied in every build route (`swap`, `plan`, `send`, `lend`, `offers`, `offramp`) using the USD value each already computes; refusal text says the cap and how to change it.
7. Wallet network check: wherever Freighter's network is compared, compare against `stellarNetwork.freighterNetwork` / passphrase; the connect flow says "switch Freighter to Mainnet" or "to Testnet" as appropriate.
8. `.env.example`: `NEXT_PUBLIC_STELLAR_NETWORK=testnet`, `MAINNET_MAX_TRADE_USD=50`, `MONEYGRAM_PRODUCTION_HOME_DOMAIN=`, with a paragraph on what flipping to mainnet requires.
9. Tests: network selection (default, mainnet, invalid); registry returns mainnet ids on mainnet and `undefined` where unverified; venue filtering by network; anchor availability; sponsor never calls friendbot on mainnet; cap enforced on mainnet and absent on testnet; the existing 1527 still pass on testnet (the default), and a run with `NEXT_PUBLIC_STELLAR_NETWORK=mainnet` set for the config tests only.
10. Copy this plan into `docs/superpowers/plans/2026-09-24-mainnet-readiness.md` in your commit.

## M2 — Abuse controls

**Owner: worker B. Branch `feat/abuse-controls`.**

1. Rate limiting, Postgres-backed so it holds across serverless instances: `packages/db/migrations/003_rate_limits.sql` + lazy DDL in `lib/server/rate-limit.ts`. Fixed windows: table `rate_limits(key text, window_start timestamptz, count int, primary key(key, window_start))`, one `INSERT … ON CONFLICT DO UPDATE … RETURNING count`. `checkRateLimit({ key, limit, windowSeconds })` → `{ allowed, remaining, retryAfterSeconds }`. Keys: `ip:<ip>:<family>` and `account:<G…>:<family>`, families `build`, `submit`, `compete`, `resolve`, `standing`, `auth`. Defaults per family in one table in the module, overridable by env `RATE_LIMIT_<FAMILY>` as `count/seconds`. Helper `enforceRateLimit(request, family, account?)` returns a `NextResponse` 429 with `Retry-After` or `undefined`; apply as the first statement in every POST route under `app/api` (except `standing/tick`, which has its secret). Client IP from `x-forwarded-for` first hop, else `x-real-ip`, else `'unknown'`. If the database is unreachable, **allow** and log once per process; a down limiter must not take the app down.
2. Sponsor budget: `packages/db/migrations/004_sponsor_ledger.sql` + lazy DDL: `sponsor_ledger(day date, account text, stroops bigint, count int, primary key(day, account))` plus a `'*'` account row for the daily total. In `sponsorForSubmission`, before wrapping: refuse (fall back to unsponsored, `reason: 'budget'`) when today's total would exceed `SPONSOR_DAILY_BUDGET_XLM` (default `50`) or this account's count would exceed `SPONSOR_DAILY_PER_ACCOUNT` (default `20`); record the fee after a successful wrap. Ledger through an injected query function so tests use the in-memory fake.
3. Access gate flag: `ACCESS_GATE` env, `'on' | 'off'`; default `'on'` when `NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'`, else `'off'`. Because `matcher` is static, restore the original matcher (it is in the comment in `middleware.ts`) and make the middleware function itself return `NextResponse.next()` immediately when the gate is off. Pure decision in `lib/server/access-gate.ts` `gateEnabled(env)` with tests.
4. `GET /api/sponsor` reports today's budget use alongside what it reports now.
5. `.env.example` entries for every new variable, with one-line explanations.
6. Tests: limiter arithmetic and window rollover with the fake db; 429 shape; database-down allows; budget refusals and ledger writes; per-account count; gate decision table.

## M3 — Monitoring

**Owner: worker C. Branch `feat/monitoring`.**

1. `lib/server/report.ts`: `reportError(where: string, error: unknown, context?: Record<string, unknown>)` and `reportEvent(name, context?)`. Always `console.error` with a `[where]` tag and a compact JSON context (never secrets, never signed XDR, never emails in full). When `SENTRY_DSN` is set, also forwards to Sentry. Add `@sentry/nextjs` with the standard `sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts` and `instrumentation.ts`, all inert without a DSN, `tracesSampleRate` 0.1, no source-map upload in CI (no auth token). Replace bare `catch {}` swallowing in API routes with `reportError` where the route already returns an error to the client; do not change route responses.
2. `GET /api/health`: returns `{ ok, network, checks: { database, horizon, rpc, sponsor } }` where each check is `{ ok, ms, detail? }`; `sponsor` reports `configured`, `funded`, `balanceXlm` (no secret, no address unless configured). 200 when every required check passes (database, horizon, rpc), 503 otherwise. Each check has a 3 s timeout. Composition in `lib/server/health.ts` with injected probes; tests with fakes.
3. Sponsor low-balance alert: in `runTick`, after the rules pass, read the sponsor balance; when below `SPONSOR_ALERT_XLM` (default `20`) send `EmailSender.sendAlert(to, { subject, text })` to `ALERT_EMAIL` once per day (a row in a new `alerts_sent(kind, day)` table, lazy DDL). Add `sendAlert` to both email implementations. Tests: alert fires once, not twice the same day, not when funded, not when `ALERT_EMAIL` unset.
4. `.env.example`: `SENTRY_DSN=`, `NEXT_PUBLIC_SENTRY_DSN=`, `ALERT_EMAIL=`, `SPONSOR_ALERT_XLM=20`.

## M4 — Tests in CI and a browser smoke pass

**Owner: worker D. Branch `feat/ci-tests-e2e`.**

1. `ci.yml`: add `pnpm test` (with `SKIP_LIVE=1`) after lint, before build, in the existing job.
2. Playwright in `apps/dapp/e2e/` with `playwright.config.ts`: `webServer` runs `next build && next start -p 3006` with env `AGENT_BRAIN=mock`, `NEXT_PUBLIC_USE_AI=false` if that flag gates the LLM path (check `packages/config/src/env.ts` and how the chat decides), `SKIP_LIVE=1`, and no `DATABASE_URL` (routes that need it degrade; assert the pages still render). Chromium only.
3. Smoke tests, each one file: (a) `/` redirects to a chain's intents page and the composer renders; (b) `/stellar/apps` lists Soroswap with an "Integrated" badge and Soroban Domains under "Names"; (c) `/stellar/history` shows "Connect a wallet to see its history"; (d) composing `swap $20 of USDC to XLM` with mock agents reaches the review stage or the connect-wallet prompt (whichever the app shows first without a wallet), and never an unhandled error; (e) the chain switcher lists Arc, Stellar, and Solana / Avalanche as "Coming soon"; (f) `/api/health` answers JSON (if M3 is merged by then; otherwise skip with a note).
4. CI job `e2e` (separate job, `needs: typescript`): `pnpm install --frozen-lockfile`, `npx playwright install --with-deps chromium`, run the suite, upload the Playwright report as an artifact on failure. Keep total CI time under ~12 minutes; if the build is the bottleneck, reuse the `.next` output between jobs with `actions/upload-artifact`.
5. `apps/dapp/package.json`: `"test:e2e": "playwright test"`; devDependency `@playwright/test`. Exclude `e2e/` from vitest (`vitest.config.ts` `include` already limits to `__tests__`; confirm).
6. Document how to run it locally in `apps/dapp/e2e/README.md` (ten lines).

## Waiting on the user (not code)

DeFindex API key; Noether beta access; MoneyGram production agreement; a Sentry DSN; a funded mainnet sponsor account; choice of mainnet RPC provider (public `mainnet.sorobanrpc.com` is fine to start); an external audit before real volume.
