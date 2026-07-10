'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useScrollDepth } from '../../lib/use-scroll-depth'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

const STORAGE_KEY = 'intent_newsletter'

type Status = 'idle' | 'submitting' | 'success' | 'error'

// Radiating "execution spark" — thin lines burst from a point (theme off-white).
const BURST = [
  { a: 0, len: 22 },
  { a: 30, len: 15 },
  { a: 60, len: 24 },
  { a: 90, len: 13 },
  { a: 120, len: 20 },
  { a: 150, len: 16 },
  { a: 180, len: 24 },
  { a: 210, len: 14 },
  { a: 240, len: 21 },
  { a: 270, len: 13 },
  { a: 300, len: 23 },
  { a: 330, len: 17 },
] as const

/** The intention — an accent orb with an off-white spark, drawn at (cx, cy). */
function IntentOrb({ cx, cy }: { cx: number; cy: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="9" className="text-accent" fill="currentColor" />
      <path
        d={`M${cx} ${cy - 6} C ${cx + 1} ${cy - 1} ${cx + 1.5} ${cy - 0.5} ${cx + 6} ${cy} C ${cx + 1.5} ${cy + 0.5} ${cx + 1} ${cy + 1} ${cx} ${cy + 6} C ${cx - 1} ${cy + 1} ${cx - 1.5} ${cy + 0.5} ${cx - 6} ${cy} C ${cx - 1.5} ${cy - 0.5} ${cx - 1} ${cy - 1} ${cx} ${cy - 6} Z`}
        className="text-background"
        fill="currentColor"
      />
    </>
  )
}

/**
 * Two-figure scene: a person (upper-left) states their intention — releasing a
 * glowing orb — which travels to an agent (lower-right) that catches and
 * executes it (burst + check). Organic single-colour illustration in the
 * reference's spirit, rendered in theme colours.
 */
function IntentArtwork({ animate }: { animate: boolean }) {
  const dur = (s: number) => (animate ? s : 0)
  const bx = 150 // catch / execution point
  const by = 196

  return (
    <svg
      viewBox="0 0 240 320"
      fill="none"
      className="h-full w-full"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* decorative twinkles */}
      <motion.path
        d="M204 42 L207.3 51.5 L217.3 51.7 L209.3 57.7 L212.2 67.3 L204 61.6 L195.8 67.3 L198.7 57.7 L190.7 51.7 L200.7 51.5 Z"
        className="text-accent"
        fill="currentColor"
        initial={animate ? { opacity: 0, scale: 0.5 } : false}
        animate={animate ? { opacity: [0, 1, 0.55, 1], scale: 1 } : { opacity: 1, scale: 1 }}
        transition={{
          duration: dur(3),
          ease: EASE,
          repeat: animate ? Infinity : 0,
          delay: dur(0.6),
        }}
        style={{ transformOrigin: '204px 56px' }}
      />
      <motion.path
        d="M30 138 C 31.5 148 32 148.5 42 150 C 32 151.5 31.5 152 30 162 C 28.5 152 28 151.5 18 150 C 28 148.5 28.5 148 30 138 Z"
        className="text-accent"
        fill="currentColor"
        initial={animate ? { opacity: 0, scale: 0.5 } : false}
        animate={animate ? { opacity: [0, 0.6, 1, 0.6], scale: 1 } : { opacity: 1, scale: 1 }}
        transition={{
          duration: dur(2.6),
          ease: EASE,
          repeat: animate ? Infinity : 0,
          delay: dur(1.2),
        }}
        style={{ transformOrigin: '30px 150px' }}
      />

      {/* faint path the intention travels */}
      <path
        d="M112 130 C 132 150 150 168 150 192"
        className="text-background"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeOpacity={0.22}
        strokeDasharray="2 7"
        fill="none"
      />

      {/* ---- PERSON — states the intention ---- */}
      <motion.g
        initial={animate ? { opacity: 0, y: 12, scale: 0.97 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: dur(0.55), ease: EASE, delay: dur(0.1) }}
        style={{ transformOrigin: '55px 176px' }}
      >
        {/* body */}
        <path
          d="M28 176 C 22 148 30 118 46 104 C 52 98 66 97 74 106 C 82 116 82 138 80 150 C 90 158 92 170 84 176 Z"
          className="text-accent"
          fill="currentColor"
        />
        {/* extended, offering arm */}
        <path
          d="M76 112 C 92 116 102 120 110 128"
          className="text-accent"
          stroke="currentColor"
          strokeWidth="12"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="112" cy="130" r="6" className="text-accent" fill="currentColor" />
        {/* head */}
        <circle cx="54" cy="64" r="17" className="text-accent" fill="currentColor" />
        {/* hair */}
        <g
          className="text-accent"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M42 50 C 45 42 39 39 43 33" />
          <path d="M55 46 C 58 38 51 36 55 29" />
          <path d="M67 52 C 71 45 65 42 68 36" />
        </g>
        {/* smiley (negative) */}
        <g className="text-foreground" fill="currentColor">
          <circle cx="47" cy="62" r="2.4" />
          <circle cx="61" cy="62" r="2.4" />
        </g>
        <path
          d="M46 71 Q 54 78 62 71"
          className="text-foreground"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          fill="none"
        />
      </motion.g>

      {/* ---- AGENT — catches and executes ---- */}
      <motion.g
        initial={animate ? { opacity: 0, y: 14, scale: 0.97 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: dur(0.55), ease: EASE, delay: dur(0.4) }}
        style={{ transformOrigin: '170px 280px' }}
      >
        {/* body */}
        <path
          d="M138 300 C 132 274 142 250 162 240 C 172 236 186 237 194 246 C 204 256 206 280 200 300 Z"
          className="text-accent"
          fill="currentColor"
        />
        {/* reaching arm + catching hand */}
        <path
          d="M158 240 C 152 224 150 210 150 198"
          className="text-accent"
          stroke="currentColor"
          strokeWidth="12"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="150" cy="196" r="6" className="text-accent" fill="currentColor" />
        {/* head */}
        <circle cx="170" cy="214" r="21" className="text-accent" fill="currentColor" />
        {/* antenna */}
        <path
          d="M170 194 v-11"
          className="text-accent"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="170" cy="180" r="4" className="text-accent" fill="currentColor" />
        {/* visor + eyes (negative) */}
        <rect
          x="154"
          y="207"
          width="32"
          height="13"
          rx="6.5"
          className="text-foreground"
          fill="currentColor"
        />
        <circle cx="163" cy="213.5" r="2.6" className="text-accent" fill="currentColor" />
        <circle cx="177" cy="213.5" r="2.6" className="text-accent" fill="currentColor" />
        {/* executed check on chest (negative) */}
        <circle
          cx="172"
          cy="270"
          r="9"
          className="text-foreground"
          fill="currentColor"
          fillOpacity={0.9}
        />
        <path
          d="M167 270 l3.5 3.5 l6 -7"
          className="text-accent"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </motion.g>

      {/* ---- INTENTION ORB — travels person → agent ---- */}
      {animate ? (
        <motion.g
          initial={{ x: 0, y: 0, opacity: 0 }}
          animate={{ x: [0, 20, 42, 38], y: [0, 26, 50, 66], opacity: [0, 1, 1, 0] }}
          transition={{
            duration: 2.4,
            times: [0, 0.2, 0.8, 1],
            ease: EASE,
            repeat: Infinity,
            repeatDelay: 0.5,
            delay: 0.9,
          }}
        >
          <IntentOrb cx={114} cy={132} />
        </motion.g>
      ) : (
        <IntentOrb cx={114} cy={132} />
      )}

      {/* ---- EXECUTION SPARK at the catch point ---- */}
      <motion.g
        className="text-background"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={animate ? { opacity: 0, scale: 0.5 } : false}
        animate={
          animate
            ? { opacity: [0, 0.9, 0.2, 0.9], scale: [0.6, 1.05, 0.9, 1.05] }
            : { opacity: 0.8, scale: 0.9 }
        }
        transition={{
          duration: dur(2.4),
          ease: 'easeInOut',
          repeat: animate ? Infinity : 0,
          delay: dur(1.3),
        }}
        style={{ transformOrigin: `${bx}px ${by}px` }}
      >
        {BURST.map(({ a, len }) => {
          const r = (a * Math.PI) / 180
          const l = len * 0.7
          const x1 = bx + Math.cos(r) * 5
          const y1 = by + Math.sin(r) * 5
          const x2 = bx + Math.cos(r) * (5 + l)
          const y2 = by + Math.sin(r) * (5 + l)
          return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} />
        })}
      </motion.g>
    </svg>
  )
}

export function NewsletterPopup() {
  const reachedDepth = useScrollDepth(0.5)
  const prefersReduced = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(true) // assume suppressed until we read storage
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')

  // Read suppression state on mount.
  useEffect(() => {
    setDismissed(Boolean(localStorage.getItem(STORAGE_KEY)))
  }, [])

  // Open once the user scrolls past the threshold, unless already handled.
  useEffect(() => {
    if (reachedDepth && !dismissed) {
      setOpen(true)
    }
  }, [reachedDepth, dismissed])

  const close = () => {
    setOpen(false)
    if (status !== 'success') {
      localStorage.setItem(STORAGE_KEY, 'dismissed')
      setDismissed(true)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) close()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (status === 'submitting') return
    setStatus('submitting')
    setError('')
    try {
      const res = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setStatus('error')
        setError(data.error ?? 'Something went wrong. Try again.')
        return
      }
      setStatus('success')
      localStorage.setItem(STORAGE_KEY, 'subscribed')
      setDismissed(true)
      setTimeout(() => setOpen(false), 2400)
    } catch {
      setStatus('error')
      setError('Network error. Try again.')
    }
  }

  const animateArt = open && !prefersReduced

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
              />
            </Dialog.Overlay>

            {/* centering wrapper — flex owns position so framer's transform can't offset it */}
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
              <Dialog.Content asChild forceMount>
                <motion.div
                  initial={{ opacity: 0, y: 24, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 16, scale: 0.97 }}
                  transition={{ duration: 0.45, ease: EASE }}
                  className="bg-card text-card-foreground border-border pointer-events-auto relative flex w-full max-w-3xl overflow-hidden rounded-2xl border shadow-2xl"
                >
                  <Dialog.Close
                    className="text-muted-foreground hover:bg-muted hover:text-foreground absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full transition-colors"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" strokeWidth={2} />
                  </Dialog.Close>

                  {/* left — brand / artwork panel */}
                  <div className="bg-foreground text-background relative hidden w-[42%] shrink-0 flex-col justify-between p-8 md:flex">
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="h-64 w-full px-6">
                        <IntentArtwork animate={animateArt} />
                      </div>
                    </div>
                  </div>

                  {/* right — form panel */}
                  <div className="flex w-full flex-col justify-center p-8 md:w-[58%] md:p-10">
                    {status === 'success' ? (
                      <div className="py-4 text-center md:text-left">
                        <div className="bg-accent/10 text-accent mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full md:mx-0">
                          <Check className="h-6 w-6" strokeWidth={2} />
                        </div>
                        <Dialog.Title className="font-display text-2xl tracking-tight">
                          You&apos;re on the list.
                        </Dialog.Title>
                        <Dialog.Description className="text-muted-foreground mt-2 text-sm">
                          Watch your inbox for the next signal.
                        </Dialog.Description>
                      </div>
                    ) : (
                      <>
                        <Dialog.Title className="font-display text-3xl leading-[1.1] tracking-tight">
                          Signals worth
                          <br />
                          your inbox.
                        </Dialog.Title>
                        <Dialog.Description className="text-muted-foreground mt-3 text-sm leading-relaxed">
                          Protocol updates, agent leaderboards, and early access — no noise, no
                          spam.
                        </Dialog.Description>

                        <form onSubmit={submit} className="mt-7 space-y-3">
                          <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => {
                              setEmail(e.target.value)
                              if (status === 'error') setStatus('idle')
                            }}
                            placeholder="you@email.com"
                            className="border-border bg-background focus:border-accent focus:ring-accent/30 w-full rounded-xl border px-4 py-3 text-sm outline-none transition focus:ring-4"
                          />
                          {error && <p className="text-destructive px-1 text-xs">{error}</p>}
                          <button
                            type="submit"
                            disabled={status === 'submitting'}
                            className="bg-foreground text-background group inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-6 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
                          >
                            {status === 'submitting' ? 'Subscribing…' : 'Subscribe'}
                            {status !== 'submitting' && (
                              <ArrowRight
                                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                                strokeWidth={2}
                              />
                            )}
                          </button>
                        </form>

                        <p className="text-muted-foreground mt-4 text-[11px] leading-relaxed">
                          By subscribing you agree to our{' '}
                          <a
                            href="/privacy"
                            className="text-foreground underline underline-offset-2"
                          >
                            privacy policy
                          </a>
                          .
                        </p>
                      </>
                    )}
                  </div>
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
