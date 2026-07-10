'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Check } from 'lucide-react'
import { useState } from 'react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

type Status = 'idle' | 'submitting' | 'success' | 'error'

/** Soft 3D-style envelope, floating and glowing off the black band. */
function EnvelopeArt() {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
      className="relative z-10 mx-auto -mt-14 flex h-80 w-full max-w-lg items-center justify-center md:-mt-24 md:h-[-35rem]"
    >
      {/* halos lift the envelope off the black */}
      <div className="pointer-events-none absolute h-36 w-72 rounded-full bg-white/10 blur-3xl" />
      <div className="bg-accent/20 pointer-events-none absolute h-28 w-56 translate-y-6 rounded-full blur-3xl" />

      <motion.svg
        viewBox="0 0 320 240"
        className="relative h-full w-auto"
        style={{ filter: 'drop-shadow(0 26px 44px rgba(0,0,0,0.6))', rotate: -8 }}
        animate={reduce ? { y: 0 } : { y: [0, -16, 0] }}
        transition={{ duration: 2, ease: 'easeInOut', repeat: reduce ? 0 : Infinity }}
      >
        <defs>
          <linearGradient id="nl-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f7f8fa" />
            <stop offset="1" stopColor="#d8dae1" />
          </linearGradient>
          <linearGradient id="nl-flap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#edeff2" />
            <stop offset="1" stopColor="#c9ccd5" />
          </linearGradient>
        </defs>

        {/* body */}
        <rect x="40" y="82" width="240" height="132" rx="16" fill="url(#nl-body)" />
        {/* lower fold lines */}
        <path
          d="M46 206 L160 150 M274 206 L160 150"
          stroke="#000"
          strokeOpacity="0.06"
          strokeWidth="1.5"
          fill="none"
        />
        {/* flap */}
        <path d="M40 94 L160 170 L280 94 Z" fill="url(#nl-flap)" />
        <path
          d="M40 94 L160 170 L280 94"
          stroke="#fff"
          strokeOpacity="0.7"
          strokeWidth="1.2"
          fill="none"
        />
      </motion.svg>
    </motion.div>
  )
}

export function Newsletter() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')

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
    } catch {
      setStatus('error')
      setError('Network error. Try again.')
    }
  }

  return (
    <section
      id="newsletter"
      className="text-background relative overflow-hidden px-6 py-52 md:py-64 2xl:py-72"
    >
      {/* Torn-paper band, matching How it works / For builders — black fill */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-20 top-20 bg-black md:bottom-28 md:top-28" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-24 w-full object-fill brightness-0 md:h-36"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-24 w-full object-fill brightness-0 md:h-36"
          style={{ transform: 'scaleY(-1) scaleX(-1)' }}
        />
      </div>

      <div className="mx-auto max-w-2xl text-center">
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
          className="font-display mt-5 text-3xl leading-tight tracking-tight md:text-4xl 2xl:text-[7rem] 2xl:leading-[0.8]"
        >
          Stay ahead of the market.
        </motion.h2>

        <EnvelopeArt />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, delay: 0.36, ease: EASE }}
        >
          {status === 'success' ? (
            <div className="text-accent mt-8 inline-flex items-center gap-2 text-sm font-medium">
              <span className="bg-accent/10 flex h-8 w-8 items-center justify-center rounded-full">
                <Check className="h-4 w-4" strokeWidth={2.5} />
              </span>
              You&apos;re on the list. Watch your inbox.
            </div>
          ) : (
            <form onSubmit={submit} className="mx-auto mt-8 max-w-2xl">
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (status === 'error') setStatus('idle')
                  }}
                  placeholder="you@email.com"
                  className="border-background/20 bg-background/5 text-background placeholder:text-background/40 flex-1 rounded-full border px-7 py-5 font-sans text-lg outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                />
                <button
                  type="submit"
                  disabled={status === 'submitting'}
                  className="group inline-flex items-center justify-center gap-1.5 rounded-full bg-indigo-500 px-8 py-5 font-sans text-lg font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-60"
                >
                  {status === 'submitting' ? 'Subscribing…' : 'Subscribe'}
                  {status !== 'submitting' && (
                    <ArrowRight
                      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                      strokeWidth={2}
                    />
                  )}
                </button>
              </div>
              {error && <p className="text-background/60 mt-3 text-left text-xs">{error}</p>}
            </form>
          )}
        </motion.div>

        {/* {status !== 'success' && (
          <p className="text-background/40 mt-4 font-sans text-xs">No spam. Unsubscribe anytime.</p>
        )} */}
      </div>
    </section>
  )
}
