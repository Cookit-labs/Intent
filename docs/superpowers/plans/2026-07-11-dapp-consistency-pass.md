# dApp Consistency Pass (Sub-spec G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `// TODO` placeholder UI with honest skeleton previews, add a shared layout/state primitive set, and collapse the duplicate color-token sources — so every dApp surface reads intentional.

**Architecture:** Add four pure-visual primitives to `@intent/ui` (`Skeleton`, `PageHeader`, `EmptyState`, `ErrorState`) plus a `LoadingBoundary` data-state orchestrator in `apps/dapp`. Reconcile colors so `globals.css` HSL vars are the single source and `tailwind.config.ts` only references them. Convert 9 stub pages + 17 stub components into skeleton compositions with a "Preview" badge.

**Tech Stack:** Next 14 (App Router), React 18, TypeScript, Tailwind 3, `class-variance-authority`, `lucide-react`, `tailwindcss-animate` (provides `animate-pulse`).

## Global Constraints

- Design tokens: consume Tailwind semantic classes only (`bg-card`, `text-muted-foreground`, `bg-surface-*`, `text-brand`); **no hardcoded hex, no `text-zinc-*`/`slate`/`gray`**.
- Theme is light/editorial (cream bg, white cards, indigo brand). "Intent Terminal" branding stays.
- New `@intent/ui` primitives export from `packages/ui/src/primitives/index.ts` (re-exported by package root + `./primitives` subpath).
- Fonts: `font-display` (Playfair) for titles, `font-mono` for eyebrows/captions, `font-sans` body — match existing primitives.
- No test framework in repo. Verification = `pnpm typecheck` (all packages) + running the dApp dev server (`next dev -p 3001`) and visually confirming routes.
- Do not modify components being built on the active Slice-1 branch (`intent-form`, `intent-card`, `intent-status-badge`, hooks, sdk). Only touch files still in `// TODO` stub state + the two token files.
- Commit after each task. No co-author lines (user rule).

---

### Task 1: `Skeleton` primitive

**Files:**

- Create: `packages/ui/src/primitives/skeleton.tsx`
- Modify: `packages/ui/src/primitives/index.ts`

**Interfaces:**

- Produces: `Skeleton(props: HTMLAttributes<HTMLDivElement>): JSX.Element` — a pulsing block; callers set size via `className`.

- [ ] **Step 1: Create the primitive**

`packages/ui/src/primitives/skeleton.tsx`:

```tsx
import { type HTMLAttributes } from 'react'

import { cn } from './cn'

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />
}
```

- [ ] **Step 2: Export it**

In `packages/ui/src/primitives/index.ts`, add after the `cn` export line:

```ts
export { Skeleton } from './skeleton'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @intent/ui typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/primitives/skeleton.tsx packages/ui/src/primitives/index.ts
git commit -m "feat(ui): add Skeleton primitive"
```

---

### Task 2: `PageHeader` primitive

**Files:**

- Create: `packages/ui/src/primitives/page-header.tsx`
- Modify: `packages/ui/src/primitives/index.ts`

**Interfaces:**

- Produces: `PageHeader(props: PageHeaderProps): JSX.Element` where
  `PageHeaderProps = { eyebrow?: string; title: string; description?: string; badge?: ReactNode; actions?: ReactNode }`.

- [ ] **Step 1: Create the primitive**

`packages/ui/src/primitives/page-header.tsx`:

```tsx
import { type ReactNode } from 'react'

import { cn } from './cn'

export interface PageHeaderProps {
  eyebrow?: string
  title: string
  description?: string
  badge?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
  actions,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-brand font-mono text-xs uppercase tracking-widest">{eyebrow}</p>
        ) : null}
        <div className="mt-1 flex items-center gap-3">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
```

- [ ] **Step 2: Export it**

In `packages/ui/src/primitives/index.ts`, add:

```ts
export { PageHeader, type PageHeaderProps } from './page-header'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @intent/ui typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/primitives/page-header.tsx packages/ui/src/primitives/index.ts
git commit -m "feat(ui): add PageHeader primitive"
```

---

### Task 3: `EmptyState` + `ErrorState` primitives

**Files:**

- Create: `packages/ui/src/primitives/empty-state.tsx`
- Create: `packages/ui/src/primitives/error-state.tsx`
- Modify: `packages/ui/src/primitives/index.ts`

**Interfaces:**

- Produces:
  - `EmptyState(props: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }): JSX.Element`
  - `ErrorState(props: { title?: string; description: string; onRetry?: () => void; className?: string }): JSX.Element`
- Consumes: `Button` from `./button` (existing).

- [ ] **Step 1: Create `EmptyState`**

`packages/ui/src/primitives/empty-state.tsx`:

```tsx
import { type ReactNode } from 'react'

import { cn } from './cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'border-border bg-card/40 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
        className
      )}
    >
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="font-display text-lg font-semibold">{title}</p>
      {description ? <p className="text-muted-foreground max-w-sm text-sm">{description}</p> : null}
      {action}
    </div>
  )
}
```

- [ ] **Step 2: Create `ErrorState`**

`packages/ui/src/primitives/error-state.tsx`:

```tsx
import { cn } from './cn'
import { Button } from './button'

export interface ErrorStateProps {
  title?: string
  description: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  className,
}: ErrorStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'border-destructive/30 bg-destructive/5 flex flex-col items-center justify-center gap-3 rounded-lg border px-6 py-12 text-center',
        className
      )}
    >
      <p className="font-display text-destructive text-lg font-semibold">{title}</p>
      <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 3: Export both**

In `packages/ui/src/primitives/index.ts`, add:

```ts
export { EmptyState, type EmptyStateProps } from './empty-state'
export { ErrorState, type ErrorStateProps } from './error-state'
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @intent/ui typecheck`
Expected: no errors. (If `Button` has no `outline` variant, fall back to `variant="secondary"` — verify against `packages/ui/src/primitives/button.tsx` before finalizing.)

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/primitives/empty-state.tsx packages/ui/src/primitives/error-state.tsx packages/ui/src/primitives/index.ts
git commit -m "feat(ui): add EmptyState and ErrorState primitives"
```

---

### Task 4: `LoadingBoundary` (apps/dapp)

**Files:**

- Create: `apps/dapp/components/layout/loading-boundary.tsx`

**Interfaces:**

- Consumes: `EmptyState`, `ErrorState` from `@intent/ui`.
- Produces: `LoadingBoundary(props: LoadingBoundaryProps): JSX.Element` where
  `LoadingBoundaryProps = { isLoading: boolean; isError?: boolean; error?: unknown; isEmpty?: boolean; skeleton: ReactNode; empty?: ReactNode; onRetry?: () => void; children: ReactNode }`.

- [ ] **Step 1: Create the component**

`apps/dapp/components/layout/loading-boundary.tsx`:

```tsx
'use client'

import { EmptyState, ErrorState } from '@intent/ui'
import { type ReactNode } from 'react'

export interface LoadingBoundaryProps {
  isLoading: boolean
  isError?: boolean
  error?: unknown
  isEmpty?: boolean
  skeleton: ReactNode
  empty?: ReactNode
  onRetry?: () => void
  children: ReactNode
}

export function LoadingBoundary({
  isLoading,
  isError = false,
  error,
  isEmpty = false,
  skeleton,
  empty,
  onRetry,
  children,
}: LoadingBoundaryProps): JSX.Element {
  if (isLoading) return <>{skeleton}</>
  if (isError) {
    const description = error instanceof Error ? error.message : 'Please try again in a moment.'
    return <ErrorState description={description} onRetry={onRetry} />
  }
  if (isEmpty) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  }
  return <>{children}</>
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @intent/dapp typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dapp/components/layout/loading-boundary.tsx
git commit -m "feat(dapp): add LoadingBoundary state orchestrator"
```

---

### Task 5: Token reconciliation (single source of truth)

**Files:**

- Modify: `apps/dapp/app/globals.css:6-25` (the `:root` block)
- Modify: `apps/dapp/tailwind.config.ts:20-47` (brand/accent/surface colors)

**Interfaces:** none (styling only). No visual change intended — values already match.

- [ ] **Step 1: Add surface vars to `globals.css`**

In the `:root` block of `apps/dapp/app/globals.css`, add these three lines before `--radius: 0.4rem;` (HSL equivalents of the current hex `#F5F5EF`, `#EFEFE7`, `#FFFFFF`):

```css
--surface-base: 60 20% 95.7%;
--surface-elevated: 60 20% 92%;
--surface-card: 0 0% 100%;
```

- [ ] **Step 2: Repoint `tailwind.config.ts` to the vars**

In `apps/dapp/tailwind.config.ts`, replace the `brand`, `accent`, and `surface` color blocks (lines ~20-47) with var-driven values:

```ts
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          dim: 'hsl(var(--brand) / 0.85)',
          foreground: 'hsl(var(--brand-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        surface: {
          base: 'hsl(var(--surface-base))',
          elevated: 'hsl(var(--surface-elevated))',
          card: 'hsl(var(--surface-card))',
        },
```

(Leave `border`/`input`/`ring`/`background`/`foreground` as-is — already var-driven.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @intent/dapp typecheck`
Expected: no errors.

- [ ] **Step 4: Run app, confirm no visual regression**

Run: `pnpm --filter @intent/dapp dev` (serves on `http://localhost:3001`).
Visit `/` and `/intents`. Confirm background is still cream, cards white, brand indigo — identical to before. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add apps/dapp/app/globals.css apps/dapp/tailwind.config.ts
git commit -m "refactor(dapp): make globals.css the single color-token source"
```

---

### Task 6: Competitions surfaces → skeleton preview

**Files:**

- Modify: `apps/dapp/components/competitions/competition-card.tsx`
- Modify: `apps/dapp/components/competitions/proposal-table.tsx`
- Modify: `apps/dapp/components/competitions/bid-stream.tsx`
- Modify: `apps/dapp/components/competitions/winner-announcement.tsx`
- Modify: `apps/dapp/components/realtime/competition-feed.tsx`
- Modify: `apps/dapp/app/competitions/page.tsx`
- Modify: `apps/dapp/app/competitions/[id]/page.tsx`

**Interfaces:**

- Consumes: `Skeleton`, `Card`, `PageHeader`, `Badge` from `@intent/ui`.
- Preserve each component's existing named export + signature (all are `export function Name()` with no props, `'use client'`).

- [ ] **Step 1: `competition-card.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function CompetitionCard(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </Card>
  )
}
```

- [ ] **Step 2: `proposal-table.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function ProposalTable(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </Card>
  )
}
```

- [ ] **Step 3: `bid-stream.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function BidStream(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: `winner-announcement.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function WinnerAnnouncement(): JSX.Element {
  return (
    <Card className="flex items-center gap-4 p-5">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
    </Card>
  )
}
```

- [ ] **Step 5: `competition-feed.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function CompetitionFeed(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}
```

- [ ] **Step 6: `app/competitions/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { CompetitionCard } from '../../components/competitions/competition-card'

export default function CompetitionsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Competitions"
        description="Watch agents compete to fill intents. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CompetitionCard key={i} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: `app/competitions/[id]/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { BidStream } from '../../../components/competitions/bid-stream'
import { ProposalTable } from '../../../components/competitions/proposal-table'
import { WinnerAnnouncement } from '../../../components/competitions/winner-announcement'

export default function CompetitionDetailPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Competition"
        title="Competition detail"
        description="Proposals, live bids, and the winning margin. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <WinnerAnnouncement />
      <div className="grid gap-4 lg:grid-cols-2">
        <ProposalTable />
        <BidStream />
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Typecheck + run**

Run: `pnpm --filter @intent/dapp typecheck` → no errors.
Run: `pnpm --filter @intent/dapp dev`, visit `/competitions` and `/competitions/x`. Confirm skeleton cards + "Preview · Slice 2" badge render, no `// TODO` text. Stop server.

- [ ] **Step 9: Commit**

```bash
git add apps/dapp/components/competitions apps/dapp/components/realtime/competition-feed.tsx apps/dapp/app/competitions
git commit -m "feat(dapp): competitions skeleton preview"
```

---

### Task 7: Agents surfaces → skeleton preview

**Files:**

- Modify: `apps/dapp/components/agents/agent-card.tsx`
- Modify: `apps/dapp/components/agents/win-rate-badge.tsx`
- Modify: `apps/dapp/components/agents/reputation-chart.tsx`
- Modify: `apps/dapp/app/agents/page.tsx`
- Modify: `apps/dapp/app/agents/[id]/page.tsx`

**Interfaces:** Consumes `Skeleton`, `Card`, `PageHeader`, `Badge`. Preserve named exports.

- [ ] **Step 1: `agent-card.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function AgentCard(): JSX.Element {
  return (
    <Card className="flex items-center gap-4 p-5">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-6 w-14" />
    </Card>
  )
}
```

- [ ] **Step 2: `win-rate-badge.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function WinRateBadge(): JSX.Element {
  return <Skeleton className="h-5 w-12" />
}
```

- [ ] **Step 3: `reputation-chart.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function ReputationChart(): JSX.Element {
  return (
    <Card className="p-5">
      <Skeleton className="h-48 w-full" />
    </Card>
  )
}
```

- [ ] **Step 4: `app/agents/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { AgentCard } from '../../components/agents/agent-card'

export default function AgentsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Agents"
        description="Solver agents that compete to fill intents. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <AgentCard key={i} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: `app/agents/[id]/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { ReputationChart } from '../../../components/agents/reputation-chart'

export default function AgentDetailPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Agent"
        title="Agent profile"
        description="Reputation, win rate, and execution history. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <ReputationChart />
    </div>
  )
}
```

- [ ] **Step 6: Typecheck + run**

Run: `pnpm --filter @intent/dapp typecheck` → no errors.
Run dev server, visit `/agents` and `/agents/x`. Confirm skeletons + badge, no TODO text. Stop server.

- [ ] **Step 7: Commit**

```bash
git add apps/dapp/components/agents apps/dapp/app/agents
git commit -m "feat(dapp): agents skeleton preview"
```

---

### Task 8: Leaderboard surface → skeleton preview

**Files:**

- Modify: `apps/dapp/components/leaderboard/leaderboard-table.tsx`
- Modify: `apps/dapp/components/leaderboard/rank-movement.tsx`
- Modify: `apps/dapp/app/leaderboard/page.tsx`

**Interfaces:** Consumes `Skeleton`, `Card`, `PageHeader`, `Badge`. Preserve named exports.

- [ ] **Step 1: `leaderboard-table.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function LeaderboardTable(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-5 w-6" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </Card>
  )
}
```

- [ ] **Step 2: `rank-movement.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function RankMovement(): JSX.Element {
  return <Skeleton className="h-4 w-10" />
}
```

- [ ] **Step 3: `app/leaderboard/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { LeaderboardTable } from '../../components/leaderboard/leaderboard-table'

export default function LeaderboardPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Leaderboard"
        description="Top-performing agents by win rate and volume. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <LeaderboardTable />
    </div>
  )
}
```

- [ ] **Step 4: Typecheck + run**

Run: `pnpm --filter @intent/dapp typecheck` → no errors. Visit `/leaderboard`, confirm skeleton table + "Coming soon" badge.

- [ ] **Step 5: Commit**

```bash
git add apps/dapp/components/leaderboard apps/dapp/app/leaderboard
git commit -m "feat(dapp): leaderboard skeleton preview"
```

---

### Task 9: Analytics surface → skeleton preview

**Files:**

- Modify: `apps/dapp/components/analytics/volume-chart.tsx`
- Modify: `apps/dapp/components/analytics/slippage-chart.tsx`
- Modify: `apps/dapp/components/analytics/competition-chart.tsx`
- Modify: `apps/dapp/app/analytics/page.tsx`

**Interfaces:** Consumes `Skeleton`, `Card`, `PageHeader`, `Badge`. Preserve named exports.

- [ ] **Step 1: `volume-chart.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function VolumeChart(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-40 w-full" />
    </Card>
  )
}
```

- [ ] **Step 2: `slippage-chart.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function SlippageChart(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-40 w-full" />
    </Card>
  )
}
```

- [ ] **Step 3: `competition-chart.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function CompetitionChart(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-40 w-full" />
    </Card>
  )
}
```

- [ ] **Step 4: `app/analytics/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { CompetitionChart } from '../../components/analytics/competition-chart'
import { SlippageChart } from '../../components/analytics/slippage-chart'
import { VolumeChart } from '../../components/analytics/volume-chart'

export default function AnalyticsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Analytics"
        description="Volume, slippage, and competition trends. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <VolumeChart />
        <SlippageChart />
        <CompetitionChart />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Typecheck + run**

Run: `pnpm --filter @intent/dapp typecheck` → no errors. Visit `/analytics`, confirm skeleton charts + badge.

- [ ] **Step 6: Commit**

```bash
git add apps/dapp/components/analytics apps/dapp/app/analytics
git commit -m "feat(dapp): analytics skeleton preview"
```

---

### Task 10: History, Vault, Settings + remaining stub components

**Files:**

- Modify: `apps/dapp/components/vault/escrow-card.tsx`
- Modify: `apps/dapp/components/vault/usdc-flow.tsx`
- Modify: `apps/dapp/components/realtime/websocket-status.tsx`
- Modify: `apps/dapp/components/intents/execution-timeline.tsx`
- Modify: `apps/dapp/app/history/page.tsx`
- Modify: `apps/dapp/app/vault/page.tsx`
- Modify: `apps/dapp/app/settings/page.tsx`

**Interfaces:** Consumes `Skeleton`, `Card`, `PageHeader`, `Badge`. Preserve named exports. `execution-timeline` is Slice-3 (settlement) and still stubbed — convert to skeleton; do not wire it to intent detail here.

- [ ] **Step 1: `escrow-card.tsx`**

```tsx
'use client'
import { Card, Skeleton } from '@intent/ui'

export function EscrowCard(): JSX.Element {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full" />
    </Card>
  )
}
```

- [ ] **Step 2: `usdc-flow.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function USDCFlow(): JSX.Element {
  return <Skeleton className="h-24 w-full" />
}
```

- [ ] **Step 3: `websocket-status.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function WebSocketStatus(): JSX.Element {
  return <Skeleton className="h-4 w-20" />
}
```

- [ ] **Step 4: `execution-timeline.tsx`**

```tsx
'use client'
import { Skeleton } from '@intent/ui'

export function ExecutionTimeline(): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: `app/history/page.tsx`**

```tsx
import { Badge, Card, PageHeader, Skeleton } from '@intent/ui'

export default function HistoryPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="History"
        description="Your settled and cancelled intents. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <Card className="flex flex-col gap-3 p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  )
}
```

- [ ] **Step 6: `app/vault/page.tsx`**

```tsx
import { Badge, PageHeader } from '@intent/ui'

import { EscrowCard } from '../../components/vault/escrow-card'

export default function VaultPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Vault"
        description="Escrow balances and USDC flows for your intents. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <EscrowCard />
        <EscrowCard />
      </div>
    </div>
  )
}
```

- [ ] **Step 7: `app/settings/page.tsx`**

```tsx
import { Badge, Card, PageHeader, Skeleton } from '@intent/ui'

export default function SettingsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Settings"
        description="Preferences, network, and approval controls. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <Card className="flex flex-col gap-4 p-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </Card>
    </div>
  )
}
```

- [ ] **Step 8: Typecheck + run**

Run: `pnpm --filter @intent/dapp typecheck` → no errors.
Visit `/history`, `/vault`, `/settings`. Confirm skeletons + "Coming soon" badges, no TODO text.

- [ ] **Step 9: Commit**

```bash
git add apps/dapp/components/vault apps/dapp/components/realtime/websocket-status.tsx apps/dapp/components/intents/execution-timeline.tsx apps/dapp/app/history apps/dapp/app/vault apps/dapp/app/settings
git commit -m "feat(dapp): history/vault/settings skeleton preview"
```

---

### Task 11: Final sweep + full typecheck

**Files:** none new — verification only.

- [ ] **Step 1: Confirm no placeholder drift remains**

Run: `git grep -nE 'text-zinc-|text-slate-|text-gray-|// TODO: implement|— TODO' -- apps/dapp`
Expected: no matches. If any remain in a stubbed file, convert it the same way (skeleton + semantic tokens) and re-run.

- [ ] **Step 2: Full monorepo typecheck**

Run: `pnpm typecheck`
Expected: all 9 packages pass (per project memory — turbo fails fast, so per-app checks hide sibling breakage).

- [ ] **Step 3: Full app walk-through**

Run: `pnpm --filter @intent/dapp dev`. Visit every route: `/`, `/intents`, `/competitions`, `/agents`, `/leaderboard`, `/analytics`, `/history`, `/vault`, `/settings`. Confirm consistent PageHeader + skeleton/preview styling, cream/white/indigo theme intact, zero raw TODO text. Stop server.

- [ ] **Step 4: Commit (if the sweep changed anything)**

```bash
git add -A apps/dapp
git commit -m "chore(dapp): final consistency sweep"
```

---

## Notes for the executor

- Order matters: Tasks 1-4 (primitives) must land before Tasks 6-10 (which import them). Task 5 (tokens) is independent but do it before the page tasks so previews render on reconciled tokens.
- Before finalizing Task 3, open `packages/ui/src/primitives/button.tsx` and confirm the `outline` variant exists; if not, use `variant="secondary"` in `ErrorState`.
- `Badge` already supports `variant="outline"` (confirmed in `packages/ui/src/primitives/badge.tsx`).
- Every new page file is a Server Component (no `'use client'`) — it only composes presentational children; the skeleton components carry `'use client'` as they already did.
