'use client'

import { CHAIN_DESCRIPTORS, CHAIN_ORDER } from '@intent/config'
import { ChainMark, type ChainLogoId } from '@intent/ui'
import { ChevronDown } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useChain } from '../../providers/chain-provider'

/**
 * Switches chain while staying on the same screen.
 *
 * The chain lives in the first path segment, so switching is a path rewrite:
 * `/arc/vault` becomes `/stellar/vault`. Rewriting rather than navigating home
 * means the user keeps their place, which is the whole point of the control.
 */
/** Planned, not built. Listed so the roadmap is visible; never selectable. */
const COMING_SOON: { id: ChainLogoId; name: string }[] = [
  { id: 'solana', name: 'Solana' },
  { id: 'avalanche', name: 'Avalanche' },
]

export function ChainSwitcher(): JSX.Element {
  const { slug, descriptor } = useChain()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function switchTo(next: string): void {
    setOpen(false)
    if (next === slug) return
    // Replace only the first segment; everything deeper is chain-independent.
    const rest = pathname.split('/').slice(2).join('/')
    router.push(`/${next}${rest === '' ? '/intents' : `/${rest}`}`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Chain: ${descriptor.name}. Switch chain`}
        className="border-border hover:bg-muted/60 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors"
      >
        <ChainMark chain={slug} className="h-4 w-4" />
        {descriptor.name}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Choose a chain"
          className="border-border bg-background absolute left-0 z-50 mt-1.5 w-52 rounded-lg border p-1 shadow-lg"
        >
          {CHAIN_ORDER.map((option) => {
            const d = CHAIN_DESCRIPTORS[option]
            const active = option === slug
            return (
              <button
                key={option}
                type="button"
                role="menuitem"
                onClick={() => switchTo(option)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  active ? 'bg-muted font-medium' : 'hover:bg-muted/60'
                }`}
              >
                <ChainMark chain={option} className="h-4 w-4 shrink-0" />
                <span className="flex flex-col leading-tight">
                  <span>{d.name}</span>
                  <span className="text-muted-foreground text-xs">{d.networkLabel}</span>
                </span>
              </button>
            )
          })}
          {COMING_SOON.map((c) => (
            <div
              key={c.id}
              role="menuitem"
              aria-disabled="true"
              className="text-muted-foreground flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm"
            >
              <ChainMark chain={c.id} className="h-4 w-4 shrink-0" />
              <span className="flex flex-col leading-tight">
                <span>{c.name}</span>
                <span className="text-xs">Coming soon</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
