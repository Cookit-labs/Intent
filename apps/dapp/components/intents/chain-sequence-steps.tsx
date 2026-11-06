'use client'

import { Button, Card, cn } from '@intent/ui'
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

function Mark({ mark, number }: { mark: StepMark; number: number }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium',
        mark === 'now' || mark === 'done'
          ? 'bg-bubble-me text-bubble-me-foreground'
          : 'border-border text-muted-foreground border'
      )}
    >
      {mark === 'done' ? <Check className="h-3 w-3" /> : number}
    </span>
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
      <Card className="flex flex-col gap-3 p-5">
        <ol className="flex flex-col gap-2 text-sm">
          <li className="flex items-center gap-2">
            <Mark mark={firstMark} number={1} />
            <span className={firstMark === 'now' ? 'font-medium' : undefined}>{first}</span>
          </li>
          <li className="flex items-center gap-2">
            <Mark mark={secondMark} number={2} />
            <span
              className={cn(
                '[overflow-wrap:anywhere]',
                secondMark === 'now' && 'font-medium',
                secondMark !== 'now' && secondMark !== 'done' && 'text-muted-foreground'
              )}
            >
              {second}
            </span>
          </li>
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
      </Card>
    </div>
  )
}
