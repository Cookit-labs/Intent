'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, RotateCcw, SlidersHorizontal, Timer, TriangleAlert, Zap } from 'lucide-react'
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

/** Above this, the tolerance is wide enough to be worth saying so. */
const HIGH_SLIPPAGE_BPS = 100

function percent(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="border-bubble-agent-border flex flex-col gap-3 border-t pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium">{title}</span>
        {aside}
      </div>
      {children}
    </div>
  )
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
  /** What the recommended agent proposed, for the "agent's pick" mark. */
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
  const isPreset = PRESETS.includes(bps)
  // A split is neither, so it marks neither card as the agent's.
  const agentPick = agentMode === 'rest' || agentMode === 'fill' ? agentMode : undefined
  const mode = edits.mode ?? agentPick

  const floor =
    receiveBase !== undefined && receiveBase !== ''
      ? Number(fromBaseUnits(applySlippage(receiveBase, bps)))
      : undefined

  function chooseSlippage(next: number): void {
    setCustomError(undefined)
    onChange({ ...edits, slippageBps: next })
  }

  function applyCustom(): void {
    if (customPct.trim() === '') return
    const pct = Number(customPct)
    if (!Number.isFinite(pct) || pct < 0) {
      setCustomError('Enter a percentage such as 0.5')
      return
    }
    const next = Math.round(pct * 100)
    if (next > MAX_SLIPPAGE_BPS) {
      setCustomError(`Slippage can be up to ${percent(MAX_SLIPPAGE_BPS)}`)
      return
    }
    chooseSlippage(next)
  }

  return (
    <div className="bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border rounded-3xl border shadow-[0_1px_3px_rgb(0_0_0/0.05)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="bg-bubble-me text-bubble-me-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
          <SlidersHorizontal className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-sm font-semibold">Trade settings</span>
          <span className="text-muted-foreground truncate text-xs">
            {percent(bps)} slippage ·{' '}
            {mode === 'rest' ? 'Rest at a price' : mode === 'fill' ? 'Fill now' : "Agent's plan"}
            {edits.mode === undefined && mode !== undefined ? " (agent's pick)" : ''}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-4 px-4 pb-4">
              <Section
                title="Max slippage"
                aside={
                  floor !== undefined && receiveSymbol !== undefined ? (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      Min. received{' '}
                      <span className="text-bubble-agent-foreground font-semibold">
                        {floor.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                        {receiveSymbol}
                      </span>
                    </span>
                  ) : undefined
                }
              >
                <div className="bg-muted/70 grid grid-cols-5 gap-1 rounded-full p-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setCustomPct('')
                        chooseSlippage(p)
                      }}
                      className={cn(
                        'relative rounded-full py-1.5 text-xs font-medium tabular-nums transition-colors',
                        bps === p
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {bps === p ? (
                        <motion.span
                          layoutId="slippage-thumb"
                          className="bg-background absolute inset-0 rounded-full shadow-sm"
                          transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                        />
                      ) : null}
                      <span className="relative">{percent(p)}</span>
                    </button>
                  ))}
                  <label
                    className={cn(
                      'relative flex items-center justify-center rounded-full px-2 text-xs',
                      !isPreset && 'bg-background shadow-sm'
                    )}
                  >
                    <input
                      inputMode="decimal"
                      value={customPct !== '' ? customPct : isPreset ? '' : String(bps / 100)}
                      onChange={(e) => setCustomPct(e.target.value.replace(/[^\d.]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') applyCustom()
                      }}
                      onBlur={applyCustom}
                      placeholder="Custom"
                      aria-label="Custom slippage in percent"
                      className="placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-center font-medium tabular-nums outline-none"
                    />
                    {customPct !== '' || !isPreset ? (
                      <span className="text-muted-foreground">%</span>
                    ) : null}
                  </label>
                </div>
                {customError !== undefined ? (
                  <p className="text-destructive text-xs">{customError}</p>
                ) : bps > HIGH_SLIPPAGE_BPS ? (
                  <p className="text-warning flex items-center gap-1.5 text-xs">
                    <TriangleAlert className="h-3.5 w-3.5" />A wide tolerance can mean a worse fill.
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    The swap does not go through if the price moves further than this.
                  </p>
                )}
              </Section>

              {canRest ? (
                <Section
                  title="How to execute"
                  aside={
                    edits.mode !== undefined ? (
                      <button
                        type="button"
                        onClick={() => {
                          const { mode: _mode, restPriceUsd: _price, ...rest } = edits
                          onChange(rest)
                        }}
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                      >
                        <RotateCcw className="h-3 w-3" /> Use the agent&apos;s
                      </button>
                    ) : undefined
                  }
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ['fill', Zap, 'Fill now', 'Swap at the best price on the book right now.'],
                        [
                          'rest',
                          Timer,
                          'Rest at a price',
                          'Wait on the book until your price is reached.',
                        ],
                      ] as const
                    ).map(([value, Icon, label, desc]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onChange({ ...edits, mode: value })}
                        aria-pressed={mode === value}
                        className={cn(
                          'flex items-start gap-3 rounded-2xl border p-3 text-left transition-all',
                          mode === value
                            ? 'border-brand/60 bg-bubble-me/40 dark:bg-brand/15 ring-brand/10 ring-4'
                            : 'border-bubble-agent-border hover:border-brand/30'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                            mode === value
                              ? 'bg-brand text-brand-foreground'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {label}
                            {agentPick === value ? (
                              <span className="bg-bubble-me text-bubble-me-foreground rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                                Agent&apos;s pick
                              </span>
                            ) : null}
                          </span>
                          <span className="text-muted-foreground text-xs">{desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {mode === 'rest' ? (
                    <label className="border-bubble-agent-border bg-background/70 focus-within:border-brand/60 flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm">
                      <span className="text-muted-foreground text-xs">Your price</span>
                      <span className="text-muted-foreground">$</span>
                      <input
                        inputMode="decimal"
                        value={edits.restPriceUsd !== undefined ? String(edits.restPriceUsd) : ''}
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/[^\d.]/g, ''))
                          const { restPriceUsd: _drop, ...rest } = edits
                          onChange(
                            Number.isFinite(n) && n > 0 ? { ...rest, restPriceUsd: n } : rest
                          )
                        }}
                        placeholder={
                          agentRestPriceUsd !== undefined ? String(agentRestPriceUsd) : '0.00'
                        }
                        className="placeholder:text-muted-foreground/60 min-w-0 flex-1 bg-transparent tabular-nums outline-none"
                      />
                    </label>
                  ) : null}
                  <p className="text-muted-foreground text-xs">
                    Applies when you press Review on an agent.
                  </p>
                </Section>
              ) : null}

              <Section title="Change the amount">
                <div className="border-bubble-agent-border bg-background/70 focus-within:border-brand/60 focus-within:ring-brand/15 flex items-center gap-2 rounded-full border p-1 pl-4 transition-all focus-within:ring-4">
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.$]/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && amount.trim() !== '') {
                        onAmount(amount.trim())
                        setAmount('')
                      }
                    }}
                    placeholder="e.g. 10 or $10"
                    aria-label="New amount"
                    className="placeholder:text-muted-foreground/60 min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none"
                  />
                  <button
                    type="button"
                    disabled={amount.trim() === ''}
                    onClick={() => {
                      onAmount(amount.trim())
                      setAmount('')
                    }}
                    className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40"
                  >
                    Re-quote
                  </button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Agents quote again for the new amount, so routes and prices are fresh.
                </p>
              </Section>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
