import { type HTMLAttributes } from 'react'

import { cn } from './cn'

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />
}
