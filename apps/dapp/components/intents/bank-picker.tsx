'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Loader2, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { keyHash } from '../../lib/agents/persona'

export interface Bank {
  code: string
  name: string
  logo?: string
}

/**
 * The bank's logo, or two letters and a colour that stay the same for a bank
 * when there is no logo or it fails to load.
 */
export function BankMark({ bank, className }: { bank: Bank; className?: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (bank.logo !== undefined && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={bank.logo}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn(
          'ring-border h-7 w-7 shrink-0 rounded-full bg-white object-contain ring-1',
          className
        )}
      />
    )
  }
  const hue = keyHash(bank.code) % 360
  const initials = bank.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter((w) => w !== '' && !/^(of|and|the|bank|plc|limited|ltd)$/i.test(w))
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
        className
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 30) % 360} 60% 58%))`,
      }}
    >
      {initials || bank.name.charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * A searchable bank list.
 *
 * Nigeria has a few hundred banks and microfinance institutions on the payout
 * provider's list; a native select makes the user scroll through them. Typing
 * any part of the name narrows it, and the arrow keys and Enter work as they
 * would in a select.
 */
export function BankPicker({
  id,
  banks,
  loading,
  value,
  onChange,
}: {
  id: string
  banks: Bank[] | undefined
  loading: boolean
  value: string
  onChange: (code: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = banks?.find((b) => b.code === value)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = banks ?? []
    return q === '' ? all : all.filter((b) => b.name.toLowerCase().includes(q))
  }, [banks, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(Math.max(0, banks?.findIndex((b) => b.code === value) ?? 0))
    searchRef.current?.focus()
  }, [open, banks, value])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function choose(bank: Bank | undefined): void {
    if (bank === undefined) return
    onChange(bank.code)
    setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(matches.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(matches[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'border-bubble-agent-border bg-background/70 hover:border-brand/40 flex h-12 w-full items-center gap-2.5 rounded-2xl border px-3 text-left text-sm transition-colors',
          open && 'border-brand/60 ring-brand/15 ring-4'
        )}
      >
        {loading ? (
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : selected !== undefined ? (
          <BankMark bank={selected} />
        ) : null}
        <span className={cn('flex-1 truncate', selected === undefined && 'text-muted-foreground')}>
          {selected?.name ?? (loading ? 'Loading banks…' : 'Select a bank')}
        </span>
        <ChevronDown
          className={cn('text-muted-foreground h-4 w-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      <AnimatePresence>
        {open ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="border-border bg-card absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border shadow-xl sm:min-w-[300px]"
            >
              <div className="border-border flex items-center gap-2 border-b px-3">
                <Search className="text-muted-foreground h-4 w-4" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="Search banks"
                  aria-label="Search banks"
                  className="placeholder:text-muted-foreground h-11 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
              <ul ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
                {matches.length === 0 ? (
                  <li className="text-muted-foreground px-3 py-6 text-center text-sm">
                    No bank matches “{query}”
                  </li>
                ) : (
                  matches.map((b, i) => (
                    <li
                      key={b.code}
                      data-index={i}
                      role="option"
                      aria-selected={b.code === value}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(b)}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm',
                        i === active && 'bg-muted'
                      )}
                    >
                      <BankMark bank={b} />
                      <span className="flex-1 truncate">{b.name}</span>
                      {b.code === value ? <Check className="text-brand h-4 w-4" /> : null}
                    </li>
                  ))
                )}
              </ul>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
