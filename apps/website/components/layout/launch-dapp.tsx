'use client'

import { ArrowUpRight } from 'lucide-react'

import { UNAVAILABLE, dappHref } from '@/lib/launch-dapp-options'

/**
 * Read at build time. What an unset value means, and why there is no fallback,
 * is decided in `lib/launch-dapp-options`.
 */
const HREF = dappHref(process.env['NEXT_PUBLIC_DAPP_URL'])

// For whoever deploys the site, in the console; the button itself never names
// the variable to a visitor.
if (HREF === null && typeof window !== 'undefined') {
  console.warn(
    '[launch-dapp] NEXT_PUBLIC_DAPP_URL is unset, so the Launch dApp button is disabled. ' +
      'Set it to the dApp origin (e.g. https://localhost:3001 in apps/website/.env.local, ' +
      'or, for a deployed site, the dApp URL in the environment settings of the host that builds it). ' +
      'It has no default on purpose: a hardcoded port can be served by an unrelated app.'
  )
}

export interface LaunchDappProps {
  /** `lg` for the hero and closing CTA, `sm` for the navbar. */
  size?: 'sm' | 'lg'
  /** Fills the width of its container, for the mobile sheet. */
  block?: boolean
  /** Fires on click, so the mobile menu can close itself. */
  onNavigate?: () => void
  className?: string
}

/** A plain link into the dApp, which chooses where to open and offers its own chain menu. */
export function LaunchDapp({ size = 'sm', block = false, onNavigate, className }: LaunchDappProps) {
  const sizing = size === 'lg' ? 'px-6 py-3 text-sm gap-1.5' : 'px-4 py-2 text-sm gap-1.5'
  const shape = `inline-flex items-center justify-center rounded-full font-sans font-medium ${sizing} ${
    block ? 'w-full' : ''
  }`

  return (
    <div className={className}>
      {HREF === null ? (
        <span
          aria-disabled="true"
          title={UNAVAILABLE}
          className={`bg-muted text-muted-foreground cursor-not-allowed ${shape}`}
        >
          Launch dApp
        </span>
      ) : (
        <a
          href={HREF}
          onClick={onNavigate}
          className={`bg-foreground text-background transition-opacity hover:opacity-90 ${shape}`}
        >
          Launch dApp
          <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
        </a>
      )}
    </div>
  )
}
