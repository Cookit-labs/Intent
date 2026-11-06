import Image from 'next/image'

/**
 * The logo for an asset symbol.
 *
 * One place that knows which file belongs to which token, so a swap card and a
 * history row never disagree about what USDC looks like.
 *
 * Assets without a bitmap fall back to a lettered disc rather than a broken
 * image. That matters more than it sounds: the token list grows, and the first
 * sign of a missing file should not be an empty box next to a number the user
 * is about to sign.
 */

const LOGOS: Record<string, string> = {
  XLM: '/images/stellar-logo.png',
  USDC: '/images/usdc-logo.webp',
}

export function TokenIcon({
  symbol,
  size = 20,
  className = '',
}: {
  symbol: string | undefined
  size?: number
  className?: string
}): JSX.Element | null {
  if (symbol === undefined) return null

  const code = symbol.toUpperCase()
  const src = LOGOS[code]

  if (src === undefined) {
    return (
      <span
        className={`bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-full font-medium ${className}`}
        style={{ width: size, height: size, fontSize: size * 0.45 }}
        aria-hidden
      >
        {code.slice(0, 2)}
      </span>
    )
  }

  return (
    <Image
      src={src}
      // Decorative: the symbol is always written next to the icon, so naming it
      // again only makes a screen reader say it twice.
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-full ${className}`}
    />
  )
}
