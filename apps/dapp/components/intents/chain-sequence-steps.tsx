'use client'

import { Button, cn } from '@intent/ui'
import { Check, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { ChainSequence } from '../../hooks/use-chain-sequence'
import { cashoutAmountFrom } from '../../lib/chains/sequence'
import {
  deliveredLine,
  secondStepLabel,
  stepAmount,
  stepLabels,
  stepMarks,
  type StepMark,
} from '../../lib/chains/sequence-flow'
import { toolCard } from './bubble'

const MARK_WORD: Record<StepMark, string> = {
  done: 'done',
  now: 'in progress',
  waiting: 'next',
  stopped: 'stopped',
}

/** One step as a bar with its name under it, as the payout card shows its own progress. */
function Step({ mark, label }: { mark: StepMark; label: string }): JSX.Element {
  return (
    <li className="flex min-w-0 flex-1 flex-col gap-2">
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 rounded-full transition-colors',
          mark === 'done'
            ? 'bg-brand'
            : mark === 'now'
              ? 'bg-brand/40 motion-safe:animate-pulse'
              : 'bg-muted'
        )}
      />
      <span
        className={cn(
          'flex items-start gap-1.5 text-xs leading-snug [overflow-wrap:anywhere]',
          mark === 'done' || mark === 'now' ? 'font-medium' : 'text-muted-foreground'
        )}
      >
        {mark === 'done' ? (
          <Check className="text-brand mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        {mark === 'now' ? (
          <span
            aria-hidden="true"
            className="bg-brand ring-brand/25 mx-1 mt-[0.3rem] h-1.5 w-1.5 shrink-0 rounded-full ring-4"
          />
        ) : null}
        {label}
        <span className="sr-only">, {MARK_WORD[mark]}</span>
      </span>
    </li>
  )
}

/** Both steps of a swap and what follows it, from before anything is signed. */
export function ChainSequenceSteps({ steps }: { steps: ChainSequence }): JSX.Element | null {
  const { sequence, stage, delivered, error, settled } = steps
  const ref = useRef<HTMLDivElement | null>(null)

  // The button and the form come up below a long thread, so they are brought into view.
  const shownNow = stage === 'ready' || stage === 'next' ? stage : undefined
  useEffect(() => {
    if (shownNow === undefined) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: shownNow === 'next' ? 'start' : 'nearest',
    })
  }, [shownNow])

  if (sequence === null || stage === undefined) return null

  const [first, second] = stepLabels(sequence)
  const [firstMark, secondMark] = stepMarks(stage, settled)
  // Too little to cash out offers no button. What can change is asked again at the press.
  const offer =
    stage === 'ready' && delivered !== undefined && sequence.followOn.kind === 'cashout'
      ? cashoutAmountFrom(delivered)
      : undefined
  const step =
    stage === 'ready' && delivered !== undefined
      ? stepAmount(sequence, delivered, steps.quotedOut)
      : undefined
  const ownCard = step !== undefined ? secondStepLabel(sequence, step.amount) : undefined

  return (
    <div ref={ref}>
      <div className={cn(toolCard, 'gap-4 px-5 py-4')}>
        <ol className="flex gap-3">
          <Step mark={firstMark} label={first} />
          <Step mark={secondMark} label={second} />
        </ol>

        {stage === 'swap' ? (
          <p className="text-muted-foreground text-xs leading-relaxed">{steps.swapLine}</p>
        ) : null}

        {stage === 'measuring' ? (
          <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
            Reading what reached your wallet
          </p>
        ) : null}

        {stage === 'ready' && delivered !== undefined ? (
          <p role="status" className="text-sm leading-relaxed">
            {deliveredLine(delivered, sequence)}
          </p>
        ) : null}

        {step?.note !== undefined ? (
          <p role="status" className="text-sm leading-relaxed">
            {step.note}
          </p>
        ) : null}

        {offer !== undefined ? (
          <div>
            <Button size="sm" onClick={steps.runNext}>
              Cash out {offer} USDC
            </Button>
          </div>
        ) : null}

        {ownCard !== undefined ? (
          <div>
            <Button size="sm" onClick={steps.runNext}>
              {ownCard}
            </Button>
          </div>
        ) : null}

        {stage === 'next' ? (
          <p role="status" className="text-muted-foreground text-xs leading-relaxed">
            The form below is yours to finish or leave. Leaving it pays nothing out.
          </p>
        ) : null}

        {error !== undefined ? (
          <p role="alert" className="text-sm leading-relaxed">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
