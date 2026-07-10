'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

const CONSENT_KEY = 'intent_cookie_consent'

export function CookieConsent() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(CONSENT_KEY)) {
      setVisible(true)
    }
  }, [])

  const resolve = (choice: 'accepted' | 'rejected') => {
    localStorage.setItem(CONSENT_KEY, choice)
    setVisible(false)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 32 }}
          transition={{ duration: 0.45, ease: EASE }}
          className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4 sm:px-6 sm:pb-6"
        >
          <div className="bg-card text-card-foreground border-border mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border p-5 shadow-2xl sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-muted-foreground text-sm leading-relaxed">
              We use cookies to improve your experience and analyze traffic. See our{' '}
              <a href="/privacy" className="text-foreground underline underline-offset-2">
                privacy policy
              </a>
              .
            </p>
            <div className="flex shrink-0 gap-3">
              <button
                onClick={() => resolve('rejected')}
                className="border-border text-foreground hover:bg-muted rounded-full border px-5 py-2.5 text-sm font-medium transition-colors"
              >
                Reject
              </button>
              <button
                onClick={() => resolve('accepted')}
                className="bg-foreground text-background rounded-full px-5 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
              >
                Accept
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
