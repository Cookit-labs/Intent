'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import { ArrowRight, Check } from 'lucide-react'
import { useState } from 'react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

type Status = 'idle' | 'submitting' | 'success' | 'error'

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
    <section id="newsletter" className="bg-foreground text-background relative">
      {/* torn paper edge — the light page tears away to reveal the dark section */}
      <div className="pointer-events-none absolute inset-x-0 top-0 select-none">
        <Image
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          width={1440}
          height={88}
          sizes="100vw"
          className="h-auto w-full -scale-y-100"
          priority={false}
        />
      </div>

      <div className="relative mx-auto max-w-2xl px-6 pb-24 pt-32 text-center md:pb-28 md:pt-40">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-accent font-mono text-xs uppercase tracking-[0.25em]"
        >
          Newsletter
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, delay: 0.05, ease: EASE }}
          className="font-display mt-5 text-4xl leading-tight tracking-tight 2xl:text-5xl"
        >
          Stay ahead of the market.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, delay: 0.12, ease: EASE }}
          className="text-background/70 mx-auto mt-4 max-w-md text-base leading-relaxed"
        >
          Protocol updates, agent leaderboards, and early access — no noise, no spam.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, delay: 0.2, ease: EASE }}
        >
          {status === 'success' ? (
            <div className="text-accent mt-9 inline-flex items-center gap-2 text-sm font-medium">
              <span className="bg-accent/10 flex h-8 w-8 items-center justify-center rounded-full">
                <Check className="h-4 w-4" strokeWidth={2.5} />
              </span>
              You&apos;re on the list. Watch your inbox.
            </div>
          ) : (
            <form onSubmit={submit} className="mx-auto mt-9 max-w-md">
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
                  className="border-background/20 bg-background/5 text-background placeholder:text-background/40 focus:border-accent focus:ring-accent/30 flex-1 rounded-full border px-5 py-3 text-sm outline-none transition focus:ring-2"
                />
                <button
                  type="submit"
                  disabled={status === 'submitting'}
                  className="bg-accent text-accent-foreground group inline-flex items-center justify-center gap-1.5 rounded-full px-6 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
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

        {status !== 'success' && (
          <p className="text-background/40 mt-4 text-xs">No spam. Unsubscribe anytime.</p>
        )}
      </div>
    </section>
  )
}
