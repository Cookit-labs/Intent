import Image from 'next/image'

import { cn } from '@intent/ui'

/**
 * The Intent mark beside its name.
 *
 * The artwork is dark on a transparent ground, so on a dark surface it is
 * inverted to light rather than shipped twice.
 */
export function BrandMark({
  className,
  textClassName,
}: {
  className?: string
  textClassName?: string
}): JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Image
        src="/images/intent-logo.png"
        alt=""
        width={512}
        height={361}
        priority
        className="h-5 w-auto dark:invert"
      />
      <span className={cn('font-display text-lg font-semibold tracking-tight', textClassName)}>
        Intent
      </span>
    </span>
  )
}
