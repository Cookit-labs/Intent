'use client'

import type { ChainSlug } from '@intent/types'
import { Button, ChainMark } from '@intent/ui'
import { useEffect, useRef, useState } from 'react'

import {
  BETA_NOTICE_ADVICE,
  BETA_NOTICE_POINTS,
  BETA_RELEASE,
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="bg-background/70 absolute inset-0 backdrop-blur-sm" aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="beta-notice-title"
        aria-describedby="beta-notice-body"
        className="border-border bg-background relative w-full max-w-sm rounded-xl border p-6 shadow-lg"
      >
        <div className="flex items-center gap-2">
          <ChainMark chain={slug} className="h-10 w-10" />
          <BetaPill>{`Beta ${BETA_RELEASE}`}</BetaPill>
        </div>

        <h2 id="beta-notice-title" className="font-display mt-4 text-lg font-semibold">
          {betaNoticeTitle(chainName)}
        </h2>
        <div id="beta-notice-body">
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            {betaNoticeIntro(chainName)}
          </p>
          <ul className="text-muted-foreground mt-3 list-disc space-y-1.5 pl-4 text-sm leading-relaxed">
            {BETA_NOTICE_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className="bg-muted/60 mt-4 rounded-md px-3 py-2.5 text-sm leading-relaxed">
            {BETA_NOTICE_ADVICE}
          </p>
        </div>

        <Button ref={primary} onClick={onClose} className="mt-5 w-full">
          I understand
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
