'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

/**
 * Deliberately has no fallback. A default like `http://localhost:3001` names a
 * port, not an app — any other project started first owns that port, and the
 * Arc option would hand users someone else's site with no visible error. An
 * unset value means "not configured", and the menu says so instead of guessing.
 */
const DAPP_URL = process.env['NEXT_PUBLIC_DAPP_URL']?.trim() ?? ''

/**
 * Chain marks are inline SVG rather than image files: they render at 20px in
 * the menu, where the 1024x1024 Arc.png in /public would be a 1.4MB download
 * for a handful of pixels. Inline also means they inherit `currentColor` and
 * stay legible when the site flips to dark.
 */
function ArcMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#6366f1" />
      <path
        d="M12 5.5 18.2 17.4a.7.7 0 0 1-.62 1.03H6.42a.7.7 0 0 1-.62-1.03L12 5.5Z"
        fill="#fff"
      />
      <circle cx="12" cy="14.6" r="1.85" fill="#6366f1" />
    </svg>
  )
}

function StellarMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#0f0f14" />
      <path
        d="M5.2 8.7 18.8 15.3M5.2 15.3 18.8 8.7"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.4" fill="#0f0f14" stroke="#fff" strokeWidth="1.6" />
    </svg>
  )
}

interface ChainOption {
  name: string
  tagline: string
  Mark: (props: { className?: string }) => JSX.Element
  href: string | null
}

/**
 * Both chains deep-link into the dApp's chain segment (`/arc/...`,
 * `/stellar/...`) so the choice made here survives the navigation — landing on
 * the dApp root would just bounce the user to the default chain.
 */
const CHAINS: ChainOption[] = [
  {
    name: 'Arc',
    tagline: DAPP_URL === '' ? 'Set NEXT_PUBLIC_DAPP_URL' : 'Arc testnet · live',
    Mark: ArcMark,
    href: DAPP_URL === '' ? null : `${DAPP_URL}/arc/intents`,
  },
  {
    name: 'Stellar',
    tagline: DAPP_URL === '' ? 'Set NEXT_PUBLIC_DAPP_URL' : 'Stellar testnet · live',
    Mark: StellarMark,
    href: DAPP_URL === '' ? null : `${DAPP_URL}/stellar/intents`,
  },
]

if (DAPP_URL === '' && typeof window !== 'undefined') {
  console.warn(
    '[launch-dapp] NEXT_PUBLIC_DAPP_URL is unset, so every chain option is disabled. ' +
      'Set it to the dApp origin (e.g. http://localhost:3001) in apps/website/.env.local. ' +
      'It has no default on purpose: a hardcoded port can be served by an unrelated app.'
  )
}

export interface LaunchDappProps {
  /** `lg` for the hero and closing CTA, `sm` for the navbar. */
  size?: 'sm' | 'lg'
  /** Renders the options inline instead of in a popover, for the mobile sheet. */
  variant?: 'dropdown' | 'inline'
  /** Fires when a chain is picked, so the mobile menu can close itself. */
  onNavigate?: () => void
  className?: string
}

export function LaunchDapp({
  size = 'sm',
  variant = 'dropdown',
  onNavigate,
  className,
}: LaunchDappProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Pointer-down rather than click: a click listener fires after the button's
  // own handler has already toggled `open`, so clicking the trigger while the
  // menu is open would close and immediately reopen it.
  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const trigger =
    size === 'lg'
      ? 'px-6 py-3 text-sm gap-1.5'
      : 'px-4 py-2 text-sm gap-1.5'

  function renderOption(chain: ChainOption) {
    const { name, tagline, Mark, href } = chain

    const body = (
      <>
        <Mark className="h-5 w-5 shrink-0" />
        <span className="flex flex-col items-start leading-tight">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground text-xs">{tagline}</span>
        </span>
        {href ? <ArrowUpRight className="ml-auto h-4 w-4 shrink-0" strokeWidth={2} /> : null}
      </>
    )

    const shared =
      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left font-sans text-sm transition-colors'

    if (!href) {
      return (
        <div
          key={name}
          role="menuitem"
          aria-disabled="true"
          className={`${shared} text-muted-foreground cursor-not-allowed`}
        >
          {body}
        </div>
      )
    }

    return (
      <a
        key={name}
        href={href}
        role="menuitem"
        onClick={() => {
          setOpen(false)
          onNavigate?.()
        }}
        className={`${shared} text-foreground hover:bg-muted`}
      >
        {body}
      </a>
    )
  }

  if (variant === 'inline') {
    return (
      <div className={className}>
        <p className="text-muted-foreground px-3 pb-1 font-sans text-xs font-medium uppercase tracking-wide">
          Launch dApp
        </p>
        <div className="flex flex-col gap-0.5">{CHAINS.map(renderOption)}</div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`bg-foreground text-background inline-flex items-center rounded-full font-sans font-medium transition-opacity hover:opacity-90 ${trigger}`}
      >
        Launch dApp
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="chain-menu"
            id={menuId}
            role="menu"
            aria-label="Choose a chain"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="border-border bg-background absolute right-0 z-50 mt-2 w-60 origin-top-right rounded-2xl border p-1.5 shadow-lg"
          >
            {CHAINS.map(renderOption)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
