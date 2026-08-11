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
