import { Button } from './button'
import { cn } from './cn'

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
