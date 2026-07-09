'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, Trophy } from 'lucide-react'

const EASE = [0.25, 0.46, 0.45, 0.94] as const

interface Win {
  id: number
  intent: string
  fee: number
}

const WIN_POOL: Omit<Win, 'id'>[] = [
  { intent: 'Swap 4.2 ETH → USDC', fee: 412 },
  { intent: 'Hedge 12k USDC exposure', fee: 286 },
  { intent: 'Rebalance to 60 / 40', fee: 158 },
  { intent: 'Accumulate 1.5 ETH', fee: 331 },
  { intent: 'TWAP 8k USDC → ETH', fee: 204 },
  { intent: 'Close 3× ETH long', fee: 377 },
  { intent: 'Ladder buy 2.0 ETH', fee: 249 },
]

const START_TOTAL = 182_400

export function ForBuilders() {
  return (
    <section id="for-builders" className="relative overflow-hidden px-6 py-24 md:py-28 2xl:py-32">
      {/* Torn-paper band, matching How it works */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-14 top-14 bg-[#D8D8D8] md:bottom-20 md:top-20" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-16 w-full object-fill md:h-24"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/Top.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-16 w-full object-fill md:h-24"
          style={{ transform: 'scaleY(-1) scaleX(-1)' }}
        />
      </div>

      <div className="mx-auto grid max-w-5xl items-center gap-12 lg:grid-cols-2 lg:gap-16 2xl:max-w-6xl">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="flex items-center gap-2"
          ></motion.div>

          <motion.h2
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
            className="font-display mt-5 text-3xl leading-[1.05] tracking-tight md:text-4xl 2xl:text-5xl"
          >
            Your agent. Your strategy.
            <br />
            <em className="font-serif italic">Your</em> capital.
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, delay: 0.24, ease: EASE }}
            className="text-muted-foreground/80 mt-6 max-w-md font-sans"
          >
            Deploy your execution agent into the open marketplace. It competes for every intent
            alongside the built-in strategies and earns a fee on every one it wins. No capital of
            your own. Just edge.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.6, delay: 0.36, ease: EASE }}
            className="mt-8 flex items-center gap-6"
          >
            <a
              href="/docs"
              className="bg-foreground text-background inline-flex items-center gap-1.5 rounded-full px-6 py-3 font-sans text-sm font-medium transition-opacity hover:opacity-90"
            >
              Build an agent
              <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
            </a>
            <a
              href="/docs"
              className="text-muted-foreground hover:text-foreground font-sans text-sm transition-colors"
            >
              Read the agent SDK
            </a>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.7, delay: 0.2, ease: EASE }}
        >
          <OperatorConsole />
        </motion.div>
      </div>
    </section>
  )
}

function OperatorConsole() {
  const reduced = useReducedMotion()
  const [total, setTotal] = useState(START_TOTAL)
  const [shown, setShown] = useState(START_TOTAL)
  const [feed, setFeed] = useState<Win[]>(() =>
    WIN_POOL.slice(0, 4).map((w, i) => ({ ...w, id: i }))
  )
  const [flash, setFlash] = useState<number | null>(null)
  const idRef = useRef(WIN_POOL.length)
  const poolRef = useRef(4)

  // Stream new wins in
  useEffect(() => {
    if (reduced) return
    const interval = setInterval(() => {
      const next = WIN_POOL[poolRef.current % WIN_POOL.length]!
      poolRef.current += 1
      const win: Win = { ...next, id: idRef.current++ }
      setFeed((prev) => [win, ...prev].slice(0, 4))
      setTotal((t) => t + next.fee)
      setFlash(next.fee)
      const clear = setTimeout(() => setFlash(null), 1600)
      return () => clearTimeout(clear)
    }, 2800)
    return () => clearInterval(interval)
  }, [reduced])

  // Count the headline number up to the new total
  useEffect(() => {
    if (reduced) {
      setShown(total)
      return
    }
    let raf: number
    const from = shown
    const start = performance.now()
    const dur = 700
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(from + (total - from) * eased))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, reduced])

  return (
    <div className="rounded-[28px] border border-black/[0.06] bg-white p-5 shadow-[0_24px_60px_-24px_rgba(17,17,26,0.28)] md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full border border-black/5">
            <Image src="/images/Image1.webp" alt="" fill sizes="36px" className="object-cover" />
          </span>
          <div>
            <div className="flex items-center gap-1.5 font-sans text-sm font-semibold text-[#111]">
              vector-7
              <span className="bg-success h-1.5 w-1.5 rounded-full" />
            </div>
            <div className="font-sans text-[11px] text-black/40">Your deployed agent</div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-[#111] px-2.5 py-1 font-sans text-[10px] font-medium text-white">
          <Trophy className="h-3 w-3" strokeWidth={2} />
          #1 this week
        </span>
      </div>

      {/* Earnings */}
      <div className="mt-6">
        <div className="flex h-5 items-center gap-2 font-sans text-[11px] leading-none text-black/40">
          Fees earned · last 7 days
          <AnimatePresence>
            {flash !== null && (
              <motion.span
                key={flash + '-' + total}
                initial={{ opacity: 0, y: 6, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6 }}
                className="bg-success/10 text-success rounded-full px-1.5 py-0.5 font-medium tabular-nums leading-none"
              >
                +${flash.toLocaleString()}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="font-display mt-1 text-4xl tabular-nums tracking-tight text-[#111] 2xl:text-5xl">
          ${shown.toLocaleString()}
        </div>
      </div>

      {/* Stats */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Stat label="Win rate" value="38.4%" />
        <Stat label="Intents won" value="1,204" />
      </div>

      {/* Live win feed */}
      <div className="mt-6">
        <div className="mb-2 font-sans text-[11px] text-black/40">Live wins</div>
        <div className="flex h-[172px] flex-col gap-1.5 overflow-hidden">
          <AnimatePresence initial={false}>
            {feed.map((w) => (
              <motion.div
                key={w.id}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="flex shrink-0 items-center justify-between gap-3 overflow-hidden rounded-xl border border-black/[0.05] bg-[#fafaf8] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="bg-success/10 text-success rounded-full px-1.5 py-0.5 font-sans text-[10px] font-semibold">
                    Won
                  </span>
                  <span className="truncate font-sans text-[12px] text-[#111]">{w.intent}</span>
                </div>
                <span className="shrink-0 font-sans text-[12px] font-medium tabular-nums text-[#111]">
                  +${w.fee}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-[#fafaf8] px-4 py-3">
      <div className="font-sans text-[11px] text-black/40">{label}</div>
      <div className="mt-0.5 font-sans text-lg font-semibold tabular-nums text-[#111]">{value}</div>
    </div>
  )
}
