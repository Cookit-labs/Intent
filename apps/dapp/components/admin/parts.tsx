'use client'

import { cn } from '@intent/ui'
import type { ReactNode } from 'react'

import { useScope } from './scope'
import { useStats, type Stats } from './stats'

export function PageTitle({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-display text-3xl">{title}</h1>
      {hint !== undefined ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
    </div>
  )
}

export function Panel({
  title,
  hint,
  children,
  className,
}: {
  title: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section
      className={cn(
        'border-border bg-card flex min-w-0 flex-col gap-4 rounded-2xl border p-5 shadow-sm',
        className
      )}
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-medium">{title}</h2>
        {hint !== undefined ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function Kpi({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string | undefined
}): JSX.Element {
  return (
    <div className="border-border bg-card flex flex-col gap-1 rounded-2xl border p-4 shadow-sm">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="font-display text-2xl tabular-nums">{value}</span>
      {note !== undefined ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-muted-foreground py-8 text-center text-sm">{children}</p>
}

/**
 * Renders a page's body once there are numbers to show, and says plainly why
 * there are none otherwise: a chain with no usage log, a failure, or a wait.
 */
export function WithStats({ children }: { children: (stats: Stats) => ReactNode }): JSX.Element {
  const { scope } = useScope()
  const { stats, loading, error, tracked, refresh } = useStats()

  if (!tracked) {
    return (
      <Panel title={`${scope.name} usage`}>
        <EmptyNote>
          Intent does not record usage on {scope.name} yet. Stellar Mainnet and Testnet are counted
          today.
        </EmptyNote>
      </Panel>
    )
  }
  if (error !== undefined) {
    return (
      <Panel title="Could not load the numbers">
        <p className="text-muted-foreground text-sm">{error}</p>
        <button
          type="button"
          onClick={refresh}
          className="text-brand w-fit text-sm underline-offset-2 hover:underline"
        >
          Try again
        </button>
      </Panel>
    )
  }
  if (stats === null || (loading && stats === null)) {
    return (
      <div aria-busy="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="border-border bg-muted/40 h-24 animate-pulse rounded-2xl border"
          />
        ))}
      </div>
    )
  }
  return <>{children(stats)}</>
}
