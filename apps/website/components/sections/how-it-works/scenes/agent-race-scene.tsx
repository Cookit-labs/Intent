'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { GlassPanel } from '../glass-panel'
import { AmbientBlob } from '../ambient-blob'

interface Agent {
  key: string
  name: string
  reasoning: string
  proposal: string
  delay: number
  winner?: boolean
}

const AGENTS: Agent[] = [
  {
    key: 'twap',
    name: 'TWAP',
    reasoning: 'Time-slicing order flow',
    proposal: '$3,201.40 avg · 0.18% slip',
    delay: 1100,
  },
  {
    key: 'arbitrage',
    name: 'Arbitrage',
    reasoning: 'Scanning venues for spread',
    proposal: '$3,198.90 avg · 0.11% slip',
    delay: 2500,
  },
  {
    key: 'momentum',
    name: 'Momentum',
    reasoning: 'Timing entry on breakout',
    proposal: '$3,203.10 avg · 0.24% slip',
    delay: 3900,
  },
  {
    key: 'shadow',
    name: 'Shadow',
    reasoning: 'Simulating 40 execution paths',
    proposal: '$3,197.60 avg · 0.09% slip',
    delay: 5400,
    winner: true,
  },
]

const RACE_DURATION = 6800

function Equalizer() {
  return (
    <div className="flex h-3 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/50 h-full w-[2px] origin-bottom rounded-full"
          animate={{ scaleY: [0.3, 1, 0.3] }}
          transition={{ duration: 0.7, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
        />
      ))}
    </div>
  )
}

function AgentRow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 px-3 py-2">{children}</div>
}

export function AgentRaceScene() {
  const [cycleId, setCycleId] = useState(0)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [phase, setPhase] = useState<'competing' | 'decided'>('competing')
  const [secondsLeft, setSecondsLeft] = useState(30)

  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timeouts.push(t)
    }

    setRevealed({})
    setPhase('competing')
    setSecondsLeft(30)

    const start = performance.now()
    let rafId: number
    const tick = (now: number) => {
      if (cancelled) return
      const elapsed = now - start
      const remaining = Math.max(0, 30 - (elapsed / RACE_DURATION) * 30)
      setSecondsLeft(Math.ceil(remaining))
      if (elapsed < RACE_DURATION) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    AGENTS.forEach((agent) => {
      schedule(() => setRevealed((r) => ({ ...r, [agent.key]: true })), agent.delay)
    })
    schedule(() => setPhase('decided'), RACE_DURATION + 500)
    schedule(() => setCycleId((c) => c + 1), RACE_DURATION + 500 + 3200)

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
      cancelAnimationFrame(rafId)
    }
  }, [cycleId])

  return (
    <div
      className="relative h-[300px] w-full overflow-hidden rounded-2xl md:h-[320px] 2xl:h-[380px]"
      style={{ background: '#e8e8ec' }}
    >
      <AmbientBlob color="rgba(99,102,241,0.32)" size={200} top="10%" right="4%" duration={12} />
      <AmbientBlob
        color="rgba(200,150,90,0.22)"
        size={150}
        bottom="8%"
        left="4%"
        duration={15}
        delay={2}
      />
      <div
        className="pointer-events-none absolute rounded-full"
        style={{
          width: 260,
          height: 180,
          background: 'rgba(255,255,255,0.22)',
          filter: 'blur(80px)',
          top: '0%',
          left: '15%',
        }}
      />
      <div className="relative z-10 flex h-full w-full flex-col p-4 md:p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-muted-foreground/60 font-sans text-[10px]">Competition window</span>
          <div className="flex items-center gap-2">
            <span className="font-sans text-[10px] tabular-nums text-black/40">
              00:{String(secondsLeft).padStart(2, '0')}s
            </span>
            <div className="relative flex h-9 w-9 items-center justify-center">
              <svg viewBox="0 0 36 36" className="absolute h-9 w-9 -rotate-90">
                <circle
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  stroke="hsl(var(--border))"
                  strokeWidth="2.5"
                />
                <motion.circle
                  key={cycleId}
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  initial={{ pathLength: 1 }}
                  animate={{ pathLength: 0 }}
                  transition={{ duration: RACE_DURATION / 1000, ease: 'linear' }}
                />
              </svg>
              <span className="text-foreground font-sans text-[10px] font-semibold tabular-nums">
                {secondsLeft}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-center gap-2">
          {AGENTS.map((agent) => {
            const isRevealed = revealed[agent.key]
            const isWinner = Boolean(agent.winner)
            const dimmed = phase === 'decided' && !isWinner
            const showWinnerRing = phase === 'decided' && isWinner

            const rowContent = (
              <AgentRow>
                <div className="min-w-0">
                  <div className="text-foreground flex items-center gap-1.5 font-sans text-[11px] font-semibold">
                    {agent.name}
                    {showWinnerRing && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 14 }}
                        className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white"
                        style={{ background: 'linear-gradient(135deg, #6366f1, #f97316, #16a34a)' }}
                      >
                        <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        Selected
                      </motion.span>
                    )}
                  </div>
                  {!isRevealed && (
                    <div className="text-muted-foreground/70 truncate font-sans text-[9px]">
                      {agent.reasoning}
                    </div>
                  )}
                </div>

                <div className="shrink-0">
                  {!isRevealed ? (
                    <Equalizer />
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      <GlassPanel borderRadius={10}>
                        <span className="text-foreground block whitespace-nowrap px-2 py-1 font-sans text-[10px] tabular-nums">
                          {agent.proposal}
                        </span>
                      </GlassPanel>
                    </motion.div>
                  )}
                </div>
              </AgentRow>
            )

            return (
              <motion.div
                key={agent.key}
                animate={{ opacity: dimmed ? 0.4 : 1 }}
                transition={{ duration: 0.5 }}
                className={`rounded-xl ${showWinnerRing ? 'bg-black/[0.03]' : ''}`}
              >
                {rowContent}
              </motion.div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
