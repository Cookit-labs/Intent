# Intent dApp Frontend — Design Spec (Slice 1)

Date: 2026-07-11
Status: Approved for planning
Scope: First vertical slice of the `apps/dapp` frontend, plus the design-system foundation in `@intent/ui`.

---

## 1. Context

`apps/dapp` is fully scaffolded but unimplemented. The directory tree (10 pages, ~25 components, hooks, stores) exists; nearly every file is a `// TODO` stub (51 stub files across `apps/dapp` + `@intent/ui`).

**Already real (reuse, do not rebuild):**

- `apps/dapp/providers/root.tsx` — wagmi + RainbowKit + React Query + `next-themes` (forced dark), wired.
- `apps/dapp/app/layout.tsx` — fonts (Inter / Space Grotesk / JetBrains Mono), "Intent Terminal" branding.
- `apps/dapp/app/globals.css` — design tokens as HSL CSS vars (dark base, brand indigo, cyan accent).
- `apps/dapp/tailwind.config.ts` — scans `packages/ui/src`, maps brand/accent/surface + font families.
- `@intent/types` — complete domain types (`Intent`, `IntentType`, `IntentStatus`, `CreateIntentInput`, plus agent/competition/execution/leaderboard).
- `apps/dapp/lib/zod-schemas.ts` — `createIntentSchema` (matches `CreateIntentInput`).
- `apps/dapp/stores/intent.store.ts` — zustand store (`intents`, `addIntent`, `updateIntent`, select).
- `packages/ui/src/tokens/index.ts` — hex token objects (`colors`, `spacing`).

**Empty / stub (build here):**

- `@intent/ui` — all primitives + component families are `export {}`.
- All dapp pages and feature components.
- `@intent/sdk` — request helper is real; endpoints + WebSocket `connect()` are TODO.
- `apps/dapp/hooks/use-intent.ts` and siblings — stubs.

**Backend reality:** `backend/` contains **0 Go files** (only empty dirs), and `localhost:8080/health` does not respond. There is nothing to wire to. Slice 1 therefore runs against a **typed mock SDK**; the live backend swaps in later behind one flag.

---

## 2. Locked decisions

| Decision              | Choice                                                                                            | Rationale                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build objective       | Durable product (production quality)                                                              | User directive                                                                                                                                                                                                                                                                                                                                            |
| Sequencing            | Vertical slices, thin end-to-end                                                                  | User directive                                                                                                                                                                                                                                                                                                                                            |
| Data source (Slice 1) | Typed mock SDK behind `NEXT_PUBLIC_USE_MOCK`                                                      | Backend is empty; keep frontend unblocked, swap later with zero component changes                                                                                                                                                                                                                                                                         |
| UX posture            | **Show-the-mechanism** (crypto-native, transparent)                                               | Matches "Intent Terminal" aesthetic + the "watch agents compete" differentiator; right for the DeFi/hackathon audience. Architect copy so a future local-currency "simple mode" can layer on without a rewrite                                                                                                                                            |
| Visual theme          | **Full match to the website** — light/editorial (cream bg, white cards, Playfair/Cormorant fonts) | User directive: dapp must look like the website. Supersedes the earlier dark-"terminal" direction. Shared brand indigo/cyan/status tokens + `0.4rem` radius already common to both. "Show-the-mechanism" remains the information-architecture posture (transparency, visible competition) — independent of light vs. dark. Website code is never modified |
| Primitives home       | `@intent/ui` shared package                                                                       | Durable, reused by website + future apps                                                                                                                                                                                                                                                                                                                  |

---

## 3. Product principles (from market research)

These constrain every slice, not just Slice 1:

1. **Make agent competition visible.** Every incumbent (CoW, UniswapX, 1inch) hides the solver auction. Showing competing agents, their bids, the winning margin, and _why an agent won_ is Intent's signature differentiator and primary trust mechanic. This is the crown jewel of **Slice 2**, but Slice 1's data model and copy must set it up.
2. **Adopt the solved order-state UX, don't reinvent it.** Two-field pay/receive + live USD value → quote-first → sign-once/gasless → explicit states `pending → competition → executing → settled` (+ `failed`/`cancelled`) → receipt + explorer link → free, clearly-communicated failure/refund with an honest "may still settle" cancellation caveat and an anti-phishing address warning.
3. **Stablecoin-native framing.** USDC-denominated, predictable dollar fees, sub-second finality. Lead trust/settlement copy here.
4. **Trust is designed in, not assumed.** Non-custodial guarantee, escrow explanation, spend caps, and (for agent execution) approval controls are first-class UI, not footnotes.
5. **Honesty about rails.** Arc is pre-mainnet. The network badge and copy acknowledge "Arc testnet"; settlement stays chain-swappable in the data model.
6. **Performance discipline.** Emerging-market users are a strategic target; keep the bundle lean (code-split heavy views, avoid unnecessary deps) toward an eventual low-bandwidth footprint.

---

## 4. Slice roadmap

Each slice is independently shippable and production-quality. Mock SDK until the backend exists.

| Slice                                              | Delivers                                                                                       | Rationale                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **1 — Foundation + Intent submission** (this spec) | `@intent/ui` primitives, app shell, mock SDK, quote-first intent form, intents list            | Nothing renders without primitives; submission is the on-ramp to everything |
| **2 — The Competition Arena** ⭐                   | Live agent-competition view: proposals, bids, scoring, winning margin, "why won"               | The signature move; the one screen no competitor has                        |
| **3 — Settlement + receipt**                       | Explicit order states, receipt, explorer link, refund/failure UX, custody/trust surfaces       | Closes the loop, earns trust                                                |
| Later                                              | Leaderboard, agent profiles/reputation, analytics, dashboard, real Arc chain + on-chain escrow | Depends on backend + contracts                                              |

---

## 5. Slice 1 architecture

Four units, each with one clear purpose and a defined interface.

### 5.1 `@intent/ui` primitives (design-system foundation)

**Purpose:** the reusable visual vocabulary every feature composes from.
**Build:** `Button`, `Input`, `Card` (+ `CardHeader`/`CardContent`/`CardFooter`), `Badge`, `Label`, `Select`, `Separator`, `Tooltip`.
**How:** built on the Radix packages already in `packages/ui/package.json`, styled with Tailwind classes bound to the existing design tokens, variants via `class-variance-authority`. Exported from `packages/ui/src/primitives/index.ts` (already re-exported by the package root and `./primitives` subpath).
**Depends on:** Tailwind config (already scans `packages/ui/src`), design tokens.
**Token source of truth:** `globals.css` HSL vars drive Tailwind semantic colors; the hex objects in `tokens/index.ts` are for non-CSS consumers (e.g. chart libs). Primitives consume Tailwind classes only — no hardcoded hex. Reconcile any drift toward the CSS vars.

### 5.2 App shell

**Purpose:** persistent navigation frame around all routed pages.
**Build:** `components/layout/sidebar.tsx` (nav: Dashboard, Intents, Competitions, Agents, Leaderboard, Analytics, History, Vault, Settings — with only Intents active this slice), `components/layout/header.tsx` (RainbowKit connect button + network badge reading "Arc testnet"), `components/layout/app-shell.tsx` composing sidebar + header + content slot. Applied via the dashboard route-group layout.
**Depends on:** primitives, RainbowKit (wired), wagmi chain config.
**Interface:** `<AppShell>{children}</AppShell>`.

### 5.3 Mock SDK layer

**Purpose:** satisfy the `IntentClient` interface with typed fixtures so the UI is production-real without a backend.
**Build:** a mock implementation of `intents.create / list / get` returning `@intent/types` values, seeded with a small fixture set covering every `IntentStatus`. A factory selects mock vs. real from `NEXT_PUBLIC_USE_MOCK`. Mock `create` returns a `pending` intent, then transitions it to `competition` on a timer to preview Slice 2.
**Where:** co-locate with `@intent/sdk` (preferred, keeps the swap seamless) or `apps/dapp/lib/` if package wiring is heavier than the slice warrants — decided at plan time.
**Interface:** `getIntentClient(): IntentClient`. Components/hooks never branch on mock vs. real.

### 5.4 Intent submission flow

**Purpose:** user declares an outcome, sees a quote, submits, gets confirmation.
**Build:**

- `hooks/use-intent.ts` — React Query mutations/queries over the SDK (`createIntent`, `listIntents`), syncing zustand `intent.store` for optimistic add.
- `components/intents/intent-form.tsx` — react-hook-form + `createIntentSchema` (`@hookform/resolvers`). Outcome-first: an intent-type selector (leveraging the full `IntentType` union — market buy/sell, limit, accumulate, hedge, rebalance, route liquidity), a two-field **You pay (USDC) / You receive** layout with live USD value, a `minAmountOut` (slippage/limit) control, and a deadline. A **quote-first preview** panel (projected output, fee, finality copy) renders before submit. Show-the-mechanism trust strip: non-custodial + escrow explanation + "Arc testnet" note.
- `app/intents/new/page.tsx` — hosts the form; on success routes to the intent detail/confirmation state.
- `components/intents/intent-card.tsx` + `intent-status-badge.tsx` — list row + status pill (color per `IntentStatus`).
- `app/intents/page.tsx` — user's intents list via `use-intent`.

**Data flow:**

```
IntentForm (RHF + zod)
  → useCreateIntent (React Query mutation)
  → getIntentClient().intents.create(CreateIntentInput)
  → optimistic addIntent() to zustand store
  → on success: navigate to /intents/[id] confirmation
  → mock transitions pending → competition (previews Slice 2)
Intents list ← useListIntents ← getIntentClient().intents.list()
```

**Error handling:**

- Form: field-level zod errors inline; disable submit while invalid/pending.
- Wallet not connected: form gates submit behind Connect (RainbowKit), clear prompt.
- SDK/mock error: non-destructive toast/inline error; roll back optimistic add; no partial state.
- Quote copy carries the honest "projected, may vary" + testnet caveat.

---

## 6. Out of scope for Slice 1

Competition arena (Slice 2), settlement/receipt (Slice 3), WebSocket live feed, leaderboard, agent profiles, analytics, dashboard content, real Arc chain definition, and on-chain escrow/approvals. The mock's `pending → competition` transition is a teaser only — no competition UI is built here.

---

## 7. Testing strategy

- **Primitives:** render/interaction tests per component (variants, disabled, keyboard/focus via Radix).
- **Mock SDK:** unit tests asserting fixtures satisfy `@intent/types` and status coverage.
- **Intent form:** validation (valid/invalid inputs → zod errors), submit calls SDK with correct `CreateIntentInput`, optimistic add + rollback on error, connect-gating.
- **Type safety:** full `pnpm typecheck` across all 9 packages before any push (turbo fails fast; per-app checks hide sibling breakage).

---

## 8. Open items (resolve during planning)

1. Mock SDK location: inside `@intent/sdk` vs. `apps/dapp/lib`.
2. Token source-of-truth reconciliation (`globals.css` HSL vars vs. `tokens/index.ts` hex) — pick CSS vars as canonical for styling.
3. Whether Slice 1 adds a minimal Arc testnet chain definition to `wagmi.config.ts` now (for the accurate network badge) or defers to a later slice with mainnet.
4. Toast primitive: include in Slice 1 primitive set or use a lightweight inline error only.
