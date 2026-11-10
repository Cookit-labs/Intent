'use client'

import { ChainMark, cn, type ChainLogoId } from '@intent/ui'
import { BadgeCheck } from 'lucide-react'
import { useCallback, useState } from 'react'

/**
 * The logo for an asset symbol.
 *
 * One place that knows which file belongs to which token, so a swap card and a
 * history row never disagree about what USDC looks like.
 *
 * The disc is never empty. Its letters show until a logo has loaded, and stay if it never does:
 * a logo from a token source can be slow or gone, and a blank circle beside a number the person
 * is about to sign reads as something broken.
 */

const LOGOS: Record<string, string> = {
  USDC: '/images/usdc-logo.webp',
}

/** A chain's own coin is drawn with the chain's mark, which no data source can lose. */
const NATIVE: Record<string, ChainLogoId> = {
  XLM: 'stellar',
  SOL: 'solana',
  SUI: 'sui',
  NEAR: 'near',
  WNEAR: 'near',
  AVAX: 'avalanche',
  MON: 'monad',
}

export function TokenIcon({
  symbol,
  size = 20,
  className = '',
  src: given,
  unknown = false,
  verified = false,
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
  /** Draws the verified tick on the logo's edge. */
  verified?: boolean | undefined
}): JSX.Element | null {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  // A logo can finish before the page is interactive, and then its load event is never heard.
  const seen = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete === true && img.naturalWidth > 0) setLoaded(true)
  }, [])
  if (symbol === undefined) return null

  const code = symbol.toUpperCase()
  const chain = unknown ? undefined : NATIVE[code]
  const src = unknown ? given : (LOGOS[code] ?? given)
  const tick =
    verified && size >= 20 ? (
      <BadgeCheck
        aria-hidden
        className="fill-brand text-brand-foreground ring-background absolute -bottom-0.5 -right-0.5 rounded-full ring-2"
        style={{ width: Math.max(12, size * 0.42), height: Math.max(12, size * 0.42) }}
      />
    ) : null

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {chain !== undefined ? (
        <ChainMark chain={chain} className="h-full w-full rounded-full" />
      ) : (
        <span
          className="bg-muted text-muted-foreground ring-border/50 relative flex h-full w-full items-center justify-center overflow-hidden rounded-full font-semibold ring-1"
          style={{ fontSize: Math.max(8, size * 0.36) }}
        >
          {!loaded || failed ? code.replace(/[^A-Z0-9]/g, '').slice(0, 2) : null}
          {src !== undefined && !failed ? (
            // A logo from anywhere a token source points, so there is no list of hosts to optimise from.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={seen}
              src={src}
              alt=""
              width={size}
              height={size}
              loading={LOGOS[code] !== undefined ? 'eager' : 'lazy'}
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={cn(
                'bg-background absolute inset-0 h-full w-full object-cover transition-opacity duration-200',
                loaded ? 'opacity-100' : 'opacity-0'
              )}
            />
          ) : null}
        </span>
      )}
      {tick}
    </span>
  )
}
