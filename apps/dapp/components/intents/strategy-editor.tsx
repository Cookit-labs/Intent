'use client'

import { cn } from '@intent/ui'
import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'

import { applySlippage, fromBaseUnits } from '../../lib/swap/assets'
import { MAX_SLIPPAGE_BPS } from '../../lib/swap/slippage'

/** What the user may change about how an agent's recommendation is carried out. */
export interface StrategyEdits {
  /** Tolerance in basis points. Absent means the app's default. */
  slippageBps?: number
  /** How to execute, overriding the agent's proposal. */
  mode?: 'fill' | 'rest'
  /** The price a resting order waits at, in dollars. */
  restPriceUsd?: number
}

/** 0.1%, 0.5%, 1%, 3%. A few tenths is what most swaps want; the cap is 5%. */
const PRESETS = [10, 50, 100, 300]

function percent(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

/**
 * Edits made before an agent's route is reviewed.
 *
 * Every figure here is a request, not a decision: the server validates the
 * tolerance, rebuilds the transaction with it and re-checks it before a
 * signature is asked for, so nothing set here can bypass the safety checks.
 * The mode applies when an agent is reviewed, not retroactively, which the
 * panel says.
 */
export function StrategyEditor({
  edits,
  onChange,
  defaultSlippageBps,
  receiveBase,
  receiveSymbol,
  agentMode,
  agentRestPriceUsd,
  canRest,
  onAmount,
}: {
  edits: StrategyEdits
  onChange: (next: StrategyEdits) => void
  defaultSlippageBps: number
  /** What the recommended route delivers before tolerance, in base units. */
  receiveBase?: string | undefined
  receiveSymbol?: string | undefined
  /** What the recommended agent proposed, for the "agent suggests" line. */
  agentMode?: string | undefined
  agentRestPriceUsd?: number | undefined
  /** Whether a resting order can be placed here at all. */
  canRest: boolean
  /** Changes the amount: handled as a note, so the agents re-quote it. */
  onAmount: (amount: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [customPct, setCustomPct] = useState('')
  const [customError, setCustomError] = useState<string | undefined>(undefined)
  const [amount, setAmount] = useState('')

  const bps = edits.slippageBps ?? defaultSlippageBps

  const floor =
    receiveBase !== undefined && receiveBase !== ''
      ? Number(fromBaseUnits(applySlippage(receiveBase, bps)))
      : undefined

  function chooseSlippage(next: number): void {
    setCustomError(undefined)
    onChange({ ...edits, slippageBps: next })
  }

  function applyCustom(): void {
    const pct = Number(customPct)
    if (!Number.isFinite(pct) || pct < 0) {
      setCustomError('Enter a percentage such as 0.5')
      return
    }
    const next = Math.round(pct * 100)
    if (next > MAX_SLIPPAGE_BPS) {
      setCustomError(`Up to ${percent(MAX_SLIPPAGE_BPS)}`)
      return
    }
    chooseSlippage(next)
  }

  return (
    <div className="border-border rounded-2xl border p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" /> Adjust before you review
        </span>
        <span className="text-muted-foreground text-xs">
          {percent(bps)} slippage
          {edits.mode === 'rest'
            ? ' · rest at a price'
            : edits.mode === 'fill'
              ? ' · fill now'
              : ''}
        </span>
      </button>

      {open ? (
        <div className="mt-4 flex flex-col gap-5 text-sm">
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Slippage tolerance</span>
            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => chooseSlippage(p)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs transition-colors',
                    bps === p
                      ? 'bg-foreground text-background'
                      : 'border-border hover:border-foreground/40 border'
                  )}
                >
                  {percent(p)}
                </button>
              ))}
              <span className="flex items-center gap-1.5">
                <input
                  inputMode="decimal"
                  value={customPct}
                  onChange={(e) => setCustomPct(e.target.value.replace(/[^\d.]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyCustom()
                  }}
                  placeholder="Other %"
                  aria-label="Custom slippage in percent"
                  className="border-border bg-background w-20 rounded-full border px-3 py-1.5 text-xs tabular-nums"
                />
                <button
                  type="button"
                  onClick={applyCustom}
                  className="border-border hover:border-foreground/40 rounded-full border px-3 py-1.5 text-xs transition-colors"
                >
                  Set
                </button>
              </span>
            </div>
            {customError !== undefined ? <p className="text-xs">{customError}</p> : null}
            {floor !== undefined && receiveSymbol !== undefined ? (
              <p className="text-muted-foreground text-xs tabular-nums">
                You receive at least {floor.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                {receiveSymbol}, or the swap does not go through.
              </p>
            ) : null}
          </div>

          {canRest ? (
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">How to execute</span>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ['fill', 'Fill now'],
                    ['rest', 'Rest at a price'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onChange({ ...edits, mode: value })}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-xs transition-colors',
                      edits.mode === value
                        ? 'bg-foreground text-background'
                        : 'border-border hover:border-foreground/40 border'
                    )}
                  >
                    {label}
                  </button>
                ))}
                {edits.mode !== undefined ? (
                  <button
                    type="button"
                    onClick={() => {
                      const { mode: _mode, restPriceUsd: _price, ...rest } = edits
                      onChange(rest)
                    }}
                    className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                  >
                    Use the agent’s
                  </button>
                ) : null}
              </div>
              {edits.mode === 'rest' ? (
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Price (USD)</span>
                  <input
                    inputMode="decimal"
                    value={edits.restPriceUsd !== undefined ? String(edits.restPriceUsd) : ''}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/[^\d.]/g, ''))
                      const { restPriceUsd: _drop, ...rest } = edits
                      onChange(Number.isFinite(n) && n > 0 ? { ...rest, restPriceUsd: n } : rest)
                    }}
                    placeholder={
                      agentRestPriceUsd !== undefined ? String(agentRestPriceUsd) : '0.00'
                    }
                    className="border-border bg-background w-28 rounded-full border px-3 py-1.5 tabular-nums"
                  />
                </label>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {agentMode !== undefined && agentMode !== ''
                  ? `The recommended agent suggests: ${agentMode}. `
                  : ''}
                The way you choose applies when you press Review on an agent.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">Amount</span>
            <div className="flex items-center gap-2">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.$]/g, ''))}
                placeholder="New amount"
                aria-label="New amount"
                className="border-border bg-background w-32 rounded-full border px-3 py-1.5 text-xs tabular-nums"
              />
              <button
                type="button"
                disabled={amount.trim() === ''}
                onClick={() => {
                  onAmount(amount.trim())
                  setAmount('')
                }}
                className="border-border hover:border-foreground/40 rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
              >
                Re-run with this
              </button>
            </div>
            <p className="text-muted-foreground text-xs">
              Agents quote again for the new amount, so the routes and prices are fresh.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
