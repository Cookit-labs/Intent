import Image from 'next/image'

/**
 * The Intent mark beside its name.
 *
 * The artwork is dark on a transparent ground, and this site is a light page,
 * so it is shown as it is. (An earlier version inverted it and it vanished on
 * the page's light background.)
 */
export function BrandMark({
  className = '',
  textClassName = 'font-sans text-lg font-bold tracking-tight',
}: {
  className?: string
  textClassName?: string
}): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Image
        src="/images/intent-logo.png"
        alt=""
        width={512}
        height={361}
        priority
        className="h-6 w-auto"
      />
      <span className={textClassName}>Intent</span>
    </span>
  )
}
