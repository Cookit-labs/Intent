'use client'

import { CHAIN_DESCRIPTORS, CONNECT_CHAINS } from '@intent/config'
import type { ChainSlug } from '@intent/types'
import { Button, ChainMark, cn } from '@intent/ui'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'

import { BrandMark } from '../layout/brand-mark'
import { ConnectSteps } from './connect-dialog'
import { IntentShowcase } from './intent-showcase'

const WIDE = '(min-width: 1024px)'

/** Only rendered in the browser, so this can read the window at once. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const onChange = (): void => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
}

const chainNames = CONNECT_CHAINS.map((slug) => CHAIN_DESCRIPTORS[slug].name)

/**
 * The only page a visitor sees without a wallet. The steps replace the button in
 * place rather than opening over the page, so the slides stay in view throughout.
 *
 * The slides are left out of the tree on narrow screens: there is no room for
 * them, and hidden animations would still spend a phone's battery.
 */
export function ConnectPage({
  onConnected,
}: {
  onConnected: (slug: ChainSlug) => void
}): JSX.Element {
  const wide = useIsWide()
  const [connecting, setConnecting] = useState(false)

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn('bg-background flex h-screen overflow-hidden', !wide && 'app-canvas')}>
        <main className="flex w-full flex-col overflow-y-auto px-6 py-8 lg:w-[44%] lg:shrink-0">
          <div className="flex justify-center">
            <BrandMark textClassName="text-xl" />
          </div>

          <div className="flex flex-1 items-center justify-center py-8">
            <div className="w-full max-w-md">
              <AnimatePresence mode="wait" initial={false}>
                {connecting ? (
                  <motion.div
                    key="steps"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.18 }}
                  >
                    <ConnectSteps onConnected={onConnected} onBack={() => setConnecting(false)} />
                  </motion.div>
                ) : (
                  <motion.div
                    key="start"
                    className="text-center"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18 }}
                  >
                    <h1 className="font-display text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
                      Declare the outcome you want
                    </h1>
                    <p className="text-muted-foreground mt-4 text-balance leading-relaxed">
                      Connect a wallet to start. Autonomous agents compete to get you the best
                      result.
                    </p>
                    <Button
                      size="lg"
                      onClick={() => setConnecting(true)}
                      className="mt-8 w-full gap-2"
                    >
                      <Wallet className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                      Connect wallet
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-4" aria-hidden="true">
              {CONNECT_CHAINS.map((slug) => (
                <ChainMark key={slug} chain={slug} className="h-5 w-5" />
              ))}
            </div>
            <p className="text-muted-foreground text-center text-xs">
              Works on {chainNames.slice(0, -1).join(', ')} and {chainNames.at(-1)}
            </p>
          </div>
        </main>

        {wide ? <IntentShowcase /> : null}
      </div>
    </MotionConfig>
  )
}
