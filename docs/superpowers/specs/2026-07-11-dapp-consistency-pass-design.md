# Intent dApp — Design-System Consistency Pass (Sub-spec G)

Date: 2026-07-11
Status: Approved for planning
Scope: Cross-cutting design-system consistency layer for `apps/dapp` + `@intent/ui`. First sub-spec of the "whole-report UI overhaul" decomposition; unblocks sub-specs A (Apps page), B (Dashboard), D (Intents polish).

---

## 1. Context

The dApp frontend is mid-migration to the locked light/editorial theme (cream bg, white cards, indigo brand — see slice-1 spec §2). Token migration is ~80% done, but two consistency defects remain:

1. **Placeholder drift.** 9 pages and ~17 components still render literal `// TODO: implement` / `// Foo — TODO` text in hardcoded `text-zinc-500`. This is the dominant "unfinished" signal in the app.
2. **Duplicate token sources.** `surface.*`, `brand`, and `accent` are hardcoded hex in `apps/dapp/tailwind.config.ts` **and** defined as HSL vars in `apps/dapp/app/globals.css`. Same values, two sources — drift risk. Slice-1 spec Open Item #2 already resolved the direction: CSS vars are canonical.

This sub-spec makes the _unbuilt_ surfaces look intentional and collapses the token duplication. It does **not** build feature content — Agents/Competitions/Analytics logic remains Slices 2/Later.

"Intent Terminal" branding is the product name (see `app/layout.tsx`), not a dark-theme leftover — it stays.

---

## 2. Locked decisions

| Decision               | Choice                                       | Rationale                                                                                                                           |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stub treatment         | **Loading skeletons** + honest preview badge | User directive. Skeletons read polished; the badge/caption prevents implying live data (product principle #5, honesty about rails). |
| Structure              | **Full shared layout system** (Approach C)   | User directive. Durable layer consumed by all later sub-specs, not per-page bespoke.                                                |
| Token source of truth  | **CSS vars in `globals.css`**                | Slice-1 spec Open Item #2. Zero hardcoded hex in tailwind config after this pass.                                                   |
| `LoadingBoundary` home | `apps/dapp` (not `@intent/ui`)               | It orchestrates app data-fetch states; the pure-visual primitives it renders live in `@intent/ui`.                                  |
| Sidebar "soon" dot     | **Skipped** (YAGNI)                          | Active states already work; no product need this pass.                                                                              |

---

## 3. Shared layout system

Split by durability.

### 3.1 New `@intent/ui` primitives (pure-visual, reusable by website + future apps)

Built the same way as existing primitives: Tailwind classes bound to design tokens, `class-variance-authority` for variants, exported from `packages/ui/src/primitives/index.ts`.

| Primitive    | Interface                                             | Purpose                                                        |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------- |
| `Skeleton`   | `<Skeleton className?>`                               | Animated pulse block; base unit for all skeleton compositions. |
| `PageHeader` | `{ eyebrow?, title, description?, badge?, actions? }` | Standard page top; replaces ad-hoc `<h1>` blocks.              |
| `EmptyState` | `{ icon?, title, description, action? }`              | "No intents yet" style empty surface.                          |
| `ErrorState` | `{ title?, description, onRetry? }`                   | Query-failure surface with optional retry.                     |

No new `PreviewRibbon` component — the preview marker reuses the existing `Badge`: `<PageHeader badge={<Badge variant="outline">Preview · Slice 2</Badge>} />`.

### 3.2 New `apps/dapp` component (data-state orchestration)

| Component         | Interface                                                                        | Purpose                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoadingBoundary` | `{ isLoading, isError, error?, isEmpty?, skeleton, empty?, onRetry?, children }` | Keystone. Branches: `isLoading` → `skeleton`; `isError` → `ErrorState` (wired to `onRetry`); `isEmpty` → `empty` (or default `EmptyState`); else → `children`. Every page/feature funnels its render states through this one component so branching is consistent app-wide. |

Home: `apps/dapp/components/layout/` (alongside `app-shell`, `page-header` usage).

---

## 4. Token reconciliation

Goal: `globals.css` is the single source; `tailwind.config.ts` colors all reference `hsl(var(--*))`.

- Add `--surface-base`, `--surface-elevated`, `--surface-card` HSL vars to `globals.css` (values equal to current hex: `#F5F5EF`, `#EFEFE7`, `#FFFFFF`).
- Repoint `tailwind.config.ts`: `surface.{base,elevated,card}` → `hsl(var(--surface-*))`; `brand.DEFAULT`/`brand.dim`/`accent.DEFAULT` → `hsl(var(--brand))` / derived / `hsl(var(--accent))` (vars already exist).
- No visual change intended — values already match. Verify by eye after.

---

## 5. Stub treatment

Every file still in `// TODO` stub state converts. Components already being built on the active Slice-1 branch (`intent-form`, etc.) are untouched.

### 5.1 Pages (9)

Each becomes `PageHeader` (with preview badge) + composed skeleton components. Slice mapping from the slice-1 roadmap:

| Page                                                         | Preview badge           |
| ------------------------------------------------------------ | ----------------------- |
| `competitions`, `competitions/[id]`, `agents`, `agents/[id]` | `Preview · Slice 2`     |
| `leaderboard`, `analytics`, `history`, `vault`, `settings`   | `Preview · Coming soon` |

Each page also carries a one-line caption (e.g. "Building in Slice 2") beneath the header so the skeletons never imply live loading.

### 5.2 Components (~17)

Each stubbed feature component (`AgentCard`, `AgentDetail` bits, `LeaderboardTable`, `RankMovement`, `VolumeChart`, `SlippageChart`, `CompetitionChart`, `ProposalTable`, `BidStream`, `WinnerAnnouncement`, `WinRateBadge`, `ReputationChart`, `CompetitionCard`, `CompetitionFeed`, `WebSocketStatus`, `EscrowCard`, `USDCFlow`, `ExecutionTimeline` if still stubbed) renders a `Skeleton` composition shaped like its eventual layout. When the corresponding slice implements the component, the real body replaces the skeleton in place — same file, same export.

### 5.3 Cleanup

All `text-zinc-*` / `text-slate-*` / hardcoded gray usages in stub files → semantic tokens (`text-muted-foreground`, etc.).

---

## 6. Testing

- Render/interaction tests: `Skeleton`, `PageHeader`, `EmptyState`, `ErrorState` (variants, provided/absent optional props).
- `LoadingBoundary` branch tests: loading→skeleton, error→ErrorState (+ `onRetry` fires), empty→empty/EmptyState, data→children.
- `pnpm typecheck` across all 9 packages before any push (turbo fails fast; per-app checks hide sibling breakage).

---

## 7. Out of scope

Real feature content or data (Agents/Competitions/Analytics = Slices 2/Later), the Apps page (sub-spec A), Dashboard content (sub-spec B), intent-flow polish (sub-spec D), websocket wiring. Skeletons are visual-only; no data hooks added here.

---

## 8. Decomposition context

This is sub-spec **G** of the whole-report overhaul. Remaining, each its own spec → plan → execute cycle:

- **A** — Apps page (net-new venue/integration catalog)
- **B** — Dashboard/Home content
- **D** — Intents list/detail polish
- **E/F** — Agents · Competitions · Analytics content (already Slice 2 / Later)
