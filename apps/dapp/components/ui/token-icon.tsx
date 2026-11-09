'use client'

import Image from 'next/image'
import { useState } from 'react'

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
  src: given,
  unknown = false,
}: {
  symbol: string | undefined
  size?: number
  className?: string
  /** A logo a token source reported, for a token with no file here. */
  src?: string | undefined
  /**
   * Not the token this app knows by that symbol. Anyone can name a token USDC, and drawing the real
   * logo beside it would vouch for it, so it gets the logo it reports or a lettered disc.
   */
  unknown?: boolean | undefined
}): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (symbol === undefined) return null

  const code = symbol.toUpperCase()
  const src = unknown ? undefined : LOGOS[code]

  if (src === undefined && given !== undefined && !failed) {
    return (
      // A logo from anywhere a token source points, so there is no list of hosts to optimise from.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={given}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`bg-muted shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

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
