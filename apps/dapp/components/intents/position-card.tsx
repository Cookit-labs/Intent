'use client'

import { Button, Card, cn } from '@intent/ui'
import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { TokenIcon } from '../ui/token-icon'

export function positionAmount(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : raw
}

/** Money in a venue, and the way to change it, which opens under the row it acts on. */
export function PositionCard({
  symbol,
  title,
  note,
  amount,
  open,
  onToggle,
  children,
}: {
  symbol: string
  title: string
  note: string
  amount: string
  open: boolean
  /** Left out where the position has nothing to manage. */
  onToggle?: (() => void) | undefined
  children?: ReactNode
}): JSX.Element {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 p-4">
        <TokenIcon symbol={symbol} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{title}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{note}</span>
          </div>
          <div className="mt-1.5 text-sm font-medium tabular-nums">
            {positionAmount(amount)} {symbol}
          </div>
        </div>
        {onToggle !== undefined ? (
          <Button size="sm" variant="outline" onClick={onToggle} aria-expanded={open}>
            Manage
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          </Button>
        ) : null}
      </div>
      {open && children !== undefined ? (
        <div className="border-border flex flex-col gap-3 border-t p-4">{children}</div>
      ) : null}
    </Card>
  )
}

export interface ManageMove {
  label: string
  onAmount: (amount: string) => void
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

/**
 * Taking some or all of a position out, or adding to it. Nothing here signs: each press builds a
 * card to review, and the wallet still has the last word.
 */
export function ManagePanel({
  symbol,
  held,
  out,
  into,
  all,
  busy,
  maxPlaces,
  secondary,
  extra,
}: {
  symbol: string
  /** What is in the position. A typed withdrawal above it is refused here, not quietly changed. */
  held: string
  out?: ManageMove | undefined
  into?: ManageMove | undefined
  all?: { label: string; onPress: () => void } | undefined
  busy: boolean
  maxPlaces?: number | undefined
  /** A second use for a typed amount of what is being added or taken. */
  secondary?: { label: string; disabled: boolean; onAmount: (amount: string) => void } | undefined
  /** Anything else this position offers, under the rest. */
  extra?: ReactNode
}): JSX.Element {
  const [mode, setMode] = useState<'out' | 'into'>(out !== undefined ? 'out' : 'into')
  const [draft, setDraft] = useState('')
  const move = mode === 'out' ? out : into
  const amount = typedAmount(draft, {
    maxPlaces,
    ...(mode === 'out' ? { atMost: held } : {}),
  })
  const tooMuch =
    mode === 'out' && typedAmount(draft, { maxPlaces }) !== undefined && amount === undefined

  return (
    <div className="flex flex-col gap-3">
      {out !== undefined && into !== undefined ? (
        <div
          role="group"
          aria-label="What to do"
          className="bg-muted/60 flex w-fit rounded-lg p-0.5"
        >
          {(
            [
              ['out', out.label],
              ['into', into.label],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                mode === value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {move !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="border-border bg-background focus-within:border-foreground/40 flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode="decimal"
              placeholder="Amount"
              aria-label={`Amount of ${symbol} to ${move.label.toLowerCase()}`}
              aria-invalid={tooMuch}
              disabled={busy}
              className="w-24 bg-transparent text-sm tabular-nums outline-none disabled:opacity-50"
            />
            <span className="text-muted-foreground text-xs">{symbol}</span>
          </div>
          <Button
            size="sm"
            disabled={busy || amount === undefined}
            onClick={() => {
              if (amount !== undefined) move.onAmount(amount)
            }}
          >
            {move.label}
            {amount !== undefined ? ` ${positionAmount(amount)} ${symbol}` : ''}
          </Button>
          {all !== undefined && mode === 'out' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={all.onPress}>
              {all.label}
            </Button>
          ) : null}
          {secondary !== undefined && mode === 'into' ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || amount === undefined || secondary.disabled}
              onClick={() => {
                if (amount !== undefined) secondary.onAmount(amount)
              }}
            >
              {secondary.label}
            </Button>
          ) : null}
        </div>
      ) : all !== undefined ? (
        <div>
          <Button size="sm" disabled={busy} onClick={all.onPress}>
            {all.label}
          </Button>
        </div>
      ) : null}

      {tooMuch ? (
        <p role="alert" className="text-muted-foreground text-xs">
          That is more than the {positionAmount(held)} {symbol} here.
        </p>
      ) : null}
      {extra}
    </div>
  )
}
