'use client'

import { cn } from '@intent/ui'
import { ArrowUp, Bot, FileText, Paperclip, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'

const EXAMPLES = [
  'Accumulate 2 ETH below $3,200',
  'Hedge 15,000 USDC exposure',
  'Rebalance to 60 / 40 ETH · USDC',
]

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-foreground hover:bg-muted flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors"
    >
      <Icon className="text-muted-foreground h-4 w-4" />
      {label}
    </button>
  )
}

export function ComposerInput({
  onSubmit,
  disabled = false,
  showExamples = false,
  onReset,
  placeholder = 'Describe the outcome you want…',
}: {
  onSubmit: (text: string) => void
  disabled?: boolean
  showExamples?: boolean
  onReset?: () => void
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

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
              className="bg-bubble-me/60 text-bubble-me-foreground hover:bg-bubble-me rounded-full px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'bg-muted/60 focus-within:border-brand/40 focus-within:bg-background flex items-end gap-2 rounded-[26px] border border-transparent p-1.5 transition-colors',
          disabled && 'opacity-60'
        )}
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Add to intent"
            aria-expanded={menuOpen}
            className={cn(
              'bg-background text-muted-foreground hover:text-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-all',
              menuOpen && 'text-foreground rotate-45'
            )}
          >
            <Plus className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="border-border bg-card absolute bottom-full left-0 z-20 mb-2 w-52 overflow-hidden rounded-2xl border p-1 shadow-xl">
                {onReset ? (
                  <MenuItem
                    icon={Sparkles}
                    label="New intent"
                    onClick={() => {
                      setMenuOpen(false)
                      onReset()
                    }}
                  />
                ) : null}
                <MenuItem icon={Bot} label="Add agent" onClick={() => setMenuOpen(false)} />
                <MenuItem icon={FileText} label="Attach PDF" onClick={() => setMenuOpen(false)} />
                <MenuItem icon={Paperclip} label="Attach file" onClick={() => setMenuOpen(false)} />
              </div>
            </>
          ) : null}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          className="placeholder:text-muted-foreground max-h-40 min-h-[2.25rem] flex-1 resize-none self-center bg-transparent px-2 py-1.5 text-sm outline-none"
          aria-label="Describe your intent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="Send intent"
          className="bg-brand text-brand-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all hover:opacity-90 disabled:scale-90 disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
