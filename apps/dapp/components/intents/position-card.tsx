'use client'

import { Button, cn } from '@intent/ui'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Sheet } from '../ui/sheet'
import { TokenIcon } from '../ui/token-icon'

export function positionAmount(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : raw
}

/** Whether a typed figure can be sent on: a plain positive number, and no more than is held. */
export function typedAmount(
  draft: string,
  options: { maxPlaces?: number | undefined; atMost?: string | undefined } = {}
): string | undefined {
  const text = draft.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const places = (text.split('.')[1] ?? '').length
  if (options.maxPlaces !== undefined && places > options.maxPlaces) return undefined
  if (options.atMost !== undefined && value > Number(options.atMost)) return undefined
  return text
}

/** A share of what is held, cut down (never rounded up) to the places the token keeps. */
export function shareOf(held: string, percent: number, places = 6): string | undefined {
  const value = (Number(held) * percent) / 100
  if (!Number.isFinite(value) || value <= 0) return undefined
  const factor = 10 ** Math.min(places, 8)
  const cut = Math.floor(value * factor) / factor
  return cut > 0 ? String(cut) : undefined
}

/** The app the money sits in, with the token on its corner. */
export function VenueMark({
  venueId,
  venueName,
  symbol,
  size = 40,
}: {
  venueId: string
  venueName: string
  symbol: string
  size?: number
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const corner = Math.round(size * 0.48)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {failed ? (
        <span className="bg-bubble-me text-bubble-me-foreground flex h-full w-full items-center justify-center rounded-[30%] text-sm font-semibold">
          {venueName.charAt(0)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/images/venues/${venueId}.webp`}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="ring-border/60 h-full w-full rounded-[30%] object-cover ring-1"
        />
      )}
      <span className="ring-bubble-agent absolute -bottom-1 -right-1 rounded-full ring-[3px]">
        <TokenIcon symbol={symbol} size={corner} />
      </span>
    </span>
  )
}

/** A group of positions on one surface, one row each, rather than a box around every one. */
export function PositionList({
  count,
  children,
  heading = true,
}: {
  count: number
  children: ReactNode
  /** Off where the section around it already names itself. */
  heading?: boolean
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3" aria-label="Open positions">
      {heading ? (
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-sm font-semibold">Open positions</h2>
          <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
        </div>
      ) : null}
      <div className="bg-bubble-agent border-bubble-agent-border divide-border/60 flex flex-col divide-y overflow-hidden rounded-3xl border shadow-[0_1px_3px_rgb(0_0_0/0.04)]">
        {children}
      </div>
    </section>
  )
}

/** One position. The whole row opens it, so there is no button inside a box inside a box. */
export function PositionRow({
  venueId,
  venueName,
  symbol,
  amount,
  label,
  note,
  onOpen,
}: {
  venueId: string
  venueName: string
  symbol: string
  amount: string
  /** What the money is doing: Supplied, Staked, Borrowed. */
  label: string
  note: string
  /** Absent where there is nothing to manage. */
  onOpen?: (() => void) | undefined
}): JSX.Element {
  const body = (
    <>
      <VenueMark venueId={venueId} venueName={venueName} symbol={symbol} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold">{venueName}</span>
        <span className="text-muted-foreground truncate text-xs">
          {label} · {note}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="text-[15px] font-semibold tabular-nums">{positionAmount(amount)}</span>
        <span className="text-muted-foreground text-xs">{symbol}</span>
      </span>
      {onOpen !== undefined ? (
        <ChevronRight
          aria-hidden
          className="text-muted-foreground/60 group-hover:text-foreground h-4 w-4 shrink-0 transition-all group-hover:translate-x-0.5"
        />
      ) : null}
    </>
  )
  const row = 'flex w-full items-center gap-3.5 px-4 py-3.5 text-left sm:px-5'
  return onOpen !== undefined ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Manage ${label.toLowerCase()} ${symbol} on ${venueName}`}
      className={cn(
        row,
        'hover:bg-muted/40 focus-visible:bg-muted/40 group transition-colors focus-visible:outline-none'
      )}
    >
      {body}
    </button>
  ) : (
    <div className={row}>{body}</div>
  )
}

export interface ManageMove {
  label: string
  onAmount: (amount: string) => void
}

const SHARES = [25, 50] as const

/**
 * What to do with one position, in a panel of its own: take some or all out, or add to it. Nothing
 * signs from here; each choice builds the review, which takes the panel's place until it is done.
 */
export function ManageSheet({
  open,
  onClose,
  venueId,
  venueName,
  symbol,
  held,
  label,
  out,
  into,
  all,
  busy,
  maxPlaces,
  review,
  onBack,
  secondary,
  extra,
}: {
  open: boolean
  onClose: () => void
  venueId: string
  venueName: string
  symbol: string
  /** What is in the position. A typed withdrawal above it is refused here, not quietly changed. */
  held: string
  label: string
  out?: ManageMove | undefined
  into?: ManageMove | undefined
  all?: { label: string; onPress: () => void } | undefined
  busy: boolean
  maxPlaces?: number | undefined
  /** The built action to review and sign, which replaces the form while there is one. */
  review?: ReactNode
  /** Back from a review that hasn't been signed. Absent once it can't be undone. */
  onBack?: (() => void) | undefined
  /** A second use for a typed amount of what is being added. */
  secondary?: { label: string; disabled: boolean; onAmount: (amount: string) => void } | undefined
  extra?: ReactNode
}): JSX.Element {
  const [mode, setMode] = useState<'out' | 'into'>(out !== undefined ? 'out' : 'into')
  const [draft, setDraft] = useState('')
  const [whole, setWhole] = useState(false)
  useEffect(() => {
    if (!open) return
    setDraft('')
    setWhole(false)
    setMode(out !== undefined ? 'out' : 'into')
  }, [open, out])

  const move = mode === 'out' ? out : into
  const places = maxPlaces ?? Math.max(6, (held.split('.')[1] ?? '').length)
  const amount = typedAmount(draft, {
    maxPlaces: places,
    ...(mode === 'out' ? { atMost: held } : {}),
  })
  const tooMuch =
    mode === 'out' &&
    typedAmount(draft, { maxPlaces: places }) !== undefined &&
    amount === undefined
  const takingAll = mode === 'out' && whole && all !== undefined

  function submit(): void {
    if (takingAll) all.onPress()
    else if (move !== undefined && amount !== undefined) move.onAmount(amount)
  }

  const primary = takingAll
    ? all.label
    : move === undefined
      ? ''
      : amount === undefined
        ? tooMuch
          ? `More than you have`
          : `Enter an amount`
        : `${move.label} ${positionAmount(amount)} ${symbol}`

  return (
    <Sheet open={open} onClose={onClose} label={`${venueName} position`}>
      <div className="flex flex-col gap-6 px-5 pb-6 pt-5 sm:px-7 sm:pt-8">
        <div className="flex items-center gap-4 pr-10">
          <VenueMark venueId={venueId} venueName={venueName} symbol={symbol} size={52} />
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">
              {label} on {venueName}
            </p>
            <p className="font-display text-2xl font-semibold tabular-nums tracking-tight">
              {positionAmount(held)} <span className="text-muted-foreground text-lg">{symbol}</span>
            </p>
          </div>
        </div>

        {review !== undefined ? (
          <div className="flex flex-col gap-4">
            {onBack !== undefined ? (
              <button
                type="button"
                onClick={onBack}
                className="text-muted-foreground hover:text-foreground -ml-1 inline-flex w-fit items-center gap-1.5 text-sm transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Change amount
              </button>
            ) : null}
            {review}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {out !== undefined && into !== undefined ? (
              <div
                role="tablist"
                aria-label="What to do"
                className="bg-muted/70 grid grid-cols-2 rounded-full p-1"
              >
                {(
                  [
                    ['out', out.label],
                    ['into', into.label],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mode === value}
                    onClick={() => {
                      setMode(value)
                      setWhole(false)
                    }}
                    className={cn(
                      'rounded-full py-2 text-sm font-medium transition-all',
                      mode === value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
            ) : null}

            <label
              className={cn(
                'bg-muted/50 focus-within:bg-background focus-within:ring-brand/30 flex flex-col gap-1 rounded-2xl px-4 py-3.5 ring-1 ring-transparent transition-all',
                tooMuch && 'ring-destructive/40'
              )}
            >
              <span className="text-muted-foreground text-xs">
                {mode === 'out'
                  ? `${out?.label ?? 'Amount'} · ${positionAmount(held)} ${symbol} here`
                  : `${into?.label ?? 'Amount'} · from your wallet`}
              </span>
              <span className="flex items-center gap-3">
                <input
                  value={takingAll ? held : draft}
                  onChange={(e) => {
                    setWhole(false)
                    setDraft(e.target.value)
                  }}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Amount of ${symbol} to ${(move?.label ?? '').toLowerCase()}`}
                  aria-invalid={tooMuch}
                  disabled={busy}
                  className="font-display min-w-0 flex-1 bg-transparent text-3xl font-semibold tabular-nums outline-none disabled:opacity-50"
                />
                <span className="bg-background ring-border/60 flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-sm font-medium ring-1">
                  <TokenIcon symbol={symbol} size={22} />
                  {symbol}
                </span>
              </span>
            </label>

            {mode === 'out' ? (
              <div className="flex gap-2">
                {SHARES.map((share) => {
                  const value = shareOf(held, share, places)
                  return (
                    <button
                      key={share}
                      type="button"
                      disabled={busy || value === undefined}
                      onClick={() => {
                        setWhole(false)
                        if (value !== undefined) setDraft(value)
                      }}
                      className="bg-muted/60 text-muted-foreground hover:text-foreground flex-1 rounded-full py-1.5 text-xs font-medium transition-colors disabled:opacity-40"
                    >
                      {share}%
                    </button>
                  )
                })}
                {all !== undefined ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={whole}
                    onClick={() => setWhole(true)}
                    className={cn(
                      'flex-1 rounded-full py-1.5 text-xs font-medium transition-colors disabled:opacity-40',
                      whole
                        ? 'bg-foreground text-background'
                        : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Max
                  </button>
                ) : null}
              </div>
            ) : null}

            <Button
              size="lg"
              className="h-12 w-full rounded-full text-[15px]"
              disabled={busy || (!takingAll && amount === undefined)}
              onClick={submit}
            >
              {primary}
            </Button>

            {secondary !== undefined && mode === 'into' ? (
              <button
                type="button"
                disabled={busy || amount === undefined || secondary.disabled}
                onClick={() => {
                  if (amount !== undefined) secondary.onAmount(amount)
                }}
                className="text-muted-foreground hover:text-foreground -mt-2 text-sm underline-offset-4 transition-colors hover:underline disabled:opacity-40 disabled:hover:no-underline"
              >
                {secondary.label}
              </button>
            ) : null}
            {extra}
          </div>
        )}
      </div>
    </Sheet>
  )
}
