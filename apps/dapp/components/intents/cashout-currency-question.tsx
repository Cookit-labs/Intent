'use client'

import { cn } from '@intent/ui'

import { CURRENCY_QUESTION, type CashoutCurrency } from '../../lib/weave/cashout-view'
import { agentBubble, userBubble } from './bubble'

export interface CashoutQuestionState {
  amount?: string
  choices: CashoutCurrency[]
  /** What the person answered. Set once, and the question stays in the thread as asked. */
  answer?: string
  /** An answer that couldn't be used, and what was said back. */
  retry?: { said: string; reply: string }
}

/** "Which currency?", answered by tapping one or by typing it in the composer. */
export function CashoutCurrencyQuestion({
  question,
  onChoose,
}: {
  question: CashoutQuestionState
  onChoose: (currency: CashoutCurrency) => void
}): JSX.Element {
  const open = question.answer === undefined
  return (
    <>
      <div className="flex justify-start">
        <div className={agentBubble}>{CURRENCY_QUESTION}</div>
      </div>
      {question.retry !== undefined ? (
        <>
          <div className="flex justify-end">
            <div className={userBubble}>{question.retry.said}</div>
          </div>
          <div className="flex justify-start">
            <div className={agentBubble}>{question.retry.reply}</div>
          </div>
        </>
      ) : null}
      {open ? (
        <div className="flex flex-wrap gap-2">
          {question.choices.map((choice) => (
            <button
              key={choice.code}
              type="button"
              onClick={() => onChoose(choice)}
              className={cn(
                'border-bubble-agent-border hover:bg-bubble-me hover:text-bubble-me-foreground rounded-full border px-3.5 py-2 text-sm transition-colors dark:border-white/[0.07]'
              )}
            >
              {choice.name} ({choice.code})
            </button>
          ))}
        </div>
      ) : (
        <div className="flex justify-end">
          <div className={userBubble}>{question.answer}</div>
        </div>
      )}
    </>
  )
}
