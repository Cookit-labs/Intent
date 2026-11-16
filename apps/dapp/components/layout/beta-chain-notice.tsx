'use client'

import type { ChainSlug } from '@intent/types'
import { Button, ChainMark } from '@intent/ui'
import { useEffect, useRef, useState } from 'react'

import {
  BETA_NOTICE_ACCEPT,
  BETA_NOTICE_ADVICE,
  BETA_NOTICE_POINTS,
  betaNoticeIntro,
  betaNoticeTitle,
  isBetaChain,
  rememberBetaNotice,
  shouldShowBetaNotice,
} from '../../lib/chain-beta'
import { useChain } from '../../providers/chain-provider'

/** Solid, since a translucent pill goes muddy on the header's glow. Nothing on a chain not in beta. */
export function ChainBetaTag({ slug }: { slug: ChainSlug }): JSX.Element | null {
  if (!isBetaChain(slug)) return null
  return <BetaPill>Beta</BetaPill>
}

function BetaPill({ children }: { children: string }): JSX.Element {
  return (
    <span className="bg-warning shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black">
      {children}
    </span>
  )
}

function BetaNoticeView({
  slug,
  chainName,
  onClose,
}: {
  slug: ChainSlug
  chainName: string
  onClose: () => void
}): JSX.Element {
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primary.current?.focus()
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
      // The one control here, so focus can't wander to the page behind.
      if (e.key === 'Tab') {
        e.preventDefault()
        primary.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="animate-in fade-in absolute inset-0 bg-black/45 backdrop-blur-[2px] duration-200 motion-reduce:animate-none"
        aria-hidden="true"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="beta-notice-title"
        aria-describedby="beta-notice-body"
        className="bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border dark:text-foreground animate-in fade-in slide-in-from-bottom-4 relative w-full rounded-t-3xl border px-6 pb-6 pt-7 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.35)] duration-300 motion-reduce:animate-none sm:max-w-[420px] sm:rounded-3xl sm:px-7 dark:border-white/[0.06] dark:bg-[#0F0F0F]"
      >
        <div className="flex items-center gap-4">
          <span className="bg-background flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] dark:border-white/[0.08] dark:bg-white/[0.04]">
            <ChainMark chain={slug} className="h-8 w-8" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="beta-notice-title" className="font-display text-xl font-semibold leading-tight">
              {betaNoticeTitle(chainName)}
            </h2>
            <p className="text-muted-foreground text-sm">{betaNoticeIntro(chainName)}</p>
          </div>
        </div>

        <div id="beta-notice-body" className="mt-6">
          <ul className="border-bubble-agent-border bg-background/70 divide-bubble-agent-border divide-y rounded-2xl border dark:divide-white/[0.06] dark:border-white/[0.07] dark:bg-[#121212]">
            {BETA_NOTICE_POINTS.map((point) => (
              <li key={point.lead} className="px-4 py-3">
                <p className="text-sm font-medium">{point.lead}</p>
                <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
                  {point.detail}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{BETA_NOTICE_ADVICE}</p>
        </div>

        <Button ref={primary} onClick={onClose} className="mt-5 h-11 w-full rounded-full text-sm">
          {BETA_NOTICE_ACCEPT}
        </Button>
      </div>
    </div>
  )
}

/**
 * Shown on entering a beta chain, once per chain in a browser. Read after mount, because the server
 * can't see localStorage and the first render has to match what it sent.
 */
export function BetaChainNotice(): JSX.Element | null {
  const { slug, descriptor } = useChain()
  const [openFor, setOpenFor] = useState<ChainSlug | undefined>(undefined)

  useEffect(() => {
    setOpenFor(shouldShowBetaNotice(slug, window.localStorage) ? slug : undefined)
  }, [slug])

  if (openFor !== slug) return null

  return (
    <BetaNoticeView
      slug={slug}
      chainName={descriptor.name}
      onClose={() => {
        rememberBetaNotice(slug, window.localStorage)
        setOpenFor(undefined)
      }}
    />
  )
}
