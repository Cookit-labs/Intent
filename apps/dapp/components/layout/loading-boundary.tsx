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
    return <ErrorState description={description} {...(onRetry ? { onRetry } : {})} />
  }
  if (isEmpty) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  }
  return <>{children}</>
}
