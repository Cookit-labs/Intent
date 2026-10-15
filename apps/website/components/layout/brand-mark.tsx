import Image from 'next/image'

/**
 * The Intent mark beside its name.
 *
 * The artwork is dark on a transparent ground. This site is always dark, so it
 * is inverted to light unconditionally rather than relying on a theme class
 * that is only applied after the page hydrates.
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
        className="h-5 w-auto invert"
      />
      <span className={textClassName}>Intent</span>
    </span>
  )
}
