import { cn } from '@intent/ui'

/**
 * The mark for an intent type.
 *
 * Drawn as SVG rather than shipped as a bitmap so it inherits `currentColor`
 * and stays sharp at any size. The source artwork is flat black, which would
 * disappear against a dark background and could not be dimmed for a cancelled
 * row — a stroke-based path handles both for free.
 */

/**
 * Accumulate: a coin sprouting from a seedling, held in an open hand.
 *
 * Growth over time, in the user's own custody — which is what an accumulate
 * intent is, as opposed to a single swap.
 */
function AccumulateGlyph(): JSX.Element {
  return (
    <>
      {/* Coin. Generous radius so the ring stays open at 20px — a tighter
          circle closes up under the stroke and reads as a filled dot. */}
      <circle cx="12" cy="4.9" r="3.6" />
      <path d="M12 3v3.8" />
      <path d="M13.1 3.9a1.3 1.3 0 0 0-1.1-.55c-.62 0-1.12.4-1.12.88 0 1.1 2.24.5 2.24 1.6 0 .49-.5.88-1.12.88a1.3 1.3 0 0 1-1.1-.55" />
      {/* Stem */}
      <path d="M12 8.5v6.2" />
      {/* Leaves, as single open sweeps off the stem. An enclosed leaf outline
          fills in solid at this size no matter how it is drawn, so each is one
          curve — the shape is implied by its arc, not bounded by it. */}
      <path d="M11.9 12.7C10.6 11 9.5 10.2 8.5 10" />
      <path d="M12.1 14.3c1.1-1.6 2.1-2.4 3.1-2.6" />
      {/* Sparkles */}
      <path d="M4.4 6.6v1.6M3.6 7.4h1.6M19.1 4v1.6M18.3 4.8h1.6M20 9v1.4M19.3 9.7h1.4" />
      {/* Open palm */}
      <path d="M1.7 16.4h2v4.8h-2z" />
      <path d="M3.7 17.1h6.2a1.3 1.3 0 0 1 0 2.6H7.9" />
      <path d="M9.9 17.1a2 2 0 0 1 2.9 0h6.9a1.4 1.4 0 0 1 .4 2.75l-8.2 2.2H3.7" />
    </>
  )
}

/** Everything that is not an accumulate: a directional exchange. */
function SwapGlyph(): JSX.Element {
  return (
    <>
      <path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3" />
    </>
  )
}

export function IntentTypeIcon({
  type,
  className,
}: {
  type: string
  className?: string
}): JSX.Element {
  const accumulate = type === 'accumulate'

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      // Thin. At 1.4 the glyph read as bold next to the regular-weight text
      // beside it, and the coin's ring nearly closed under its own stroke.
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-6 w-6', className)}
      aria-hidden
    >
      {accumulate ? <AccumulateGlyph /> : <SwapGlyph />}
    </svg>
  )
}
