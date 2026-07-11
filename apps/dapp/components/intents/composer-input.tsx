'use client'

import { cn } from '@intent/ui'
import { ArrowUp } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'

const EXAMPLES = [
  'Accumulate 2 ETH below $3,200',
  'Hedge 15,000 USDC exposure',
  'Rebalance to 60 / 40 ETH · USDC',
]

export function ComposerInput({
  onSubmit,
  disabled = false,
  showExamples = false,
}: {
  onSubmit: (text: string) => void
  disabled?: boolean
  showExamples?: boolean
}): JSX.Element {
  const [text, setText] = useState('')

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setText('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {showExamples ? (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={disabled}
              onClick={() => onSubmit(ex)}
              className="border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'border-border focus-within:border-foreground/40 flex items-end gap-2 rounded-xl border p-2 transition-colors',
          disabled && 'opacity-60'
        )}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="Describe the outcome you want…"
          className="placeholder:text-muted-foreground max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
          aria-label="Describe your intent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="Submit intent"
          className="bg-foreground text-background flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
