import { cn } from '@intent/ui'

export function AgentAvatar({
  gradient,
  name,
  className,
}: {
  gradient: string
  name: string
  className?: string
}): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white',
        className
      )}
      style={{ background: gradient }}
    >
      {name.charAt(0)}
    </span>
  )
}
