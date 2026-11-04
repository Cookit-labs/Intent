'use client'

import { cn } from '@intent/ui'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, type ReactNode } from 'react'

import { showChatOnPath } from '../../lib/chat/live-session'
import { intentIntro } from '../../lib/intent-intro-copy'
import { useChain } from '../../providers/chain-provider'
import { IntentChat } from './intent-chat'

/** A link that opens a rule still works when the chat is already mounted. */
function ChatFromLink({ showing }: { showing: boolean }): JSX.Element {
  const rule = useSearchParams().get('rule')
  return <IntentChat {...(showing && rule !== null ? { linkedRule: rule } : {})} />
}

/**
 * Keeps the chat mounted while the person is on another page, so a race, a card
 * or a payment being followed carries on and is there when they come back.
 *
 * Mounted on the first visit to the chat, so someone who never opens it never
 * polls for it. The page itself renders nothing; what stands in for it while it
 * loads is hidden too, or the spinner would sit under the chat.
 */
export function ChatHost({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname()
  const { segment, slug } = useChain()
  const showing = showChatOnPath(pathname, segment)
  const opened = useRef(false)
  if (showing) opened.current = true
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (showing) {
      // Following a link opens at the top. The page's own scroll-to-top has nothing to find here.
      hostRef.current?.scrollIntoView({ block: 'start' })
      return
    }
    // The bank list is drawn on the body, which `hidden` cannot reach. Escape is its own way out.
    document
      .querySelector('input[aria-label="Search banks"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }, [showing])

  const isNew = pathname === `/${segment}/intents/new`

  return (
    <>
      {opened.current ? (
        <div
          ref={hostRef}
          hidden={!showing}
          className={cn('mx-auto px-4 py-6 sm:px-6 sm:py-10', isNew ? 'max-w-2xl' : 'max-w-4xl')}
        >
          <div className="mb-6">
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              {isNew ? 'Submit an intent' : 'Intents'}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {isNew ? intentIntro(slug) : 'Say what you want. Agents compete to deliver it.'}
            </p>
          </div>
          <Suspense fallback={null}>
            <ChatFromLink showing={showing} />
          </Suspense>
        </div>
      ) : null}
      <div className={showing ? 'hidden' : 'contents'}>{children}</div>
    </>
  )
}
