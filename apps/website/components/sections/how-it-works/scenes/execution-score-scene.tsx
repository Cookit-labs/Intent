'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { GlassPanel } from '../glass-panel'
import { AmbientBlob } from '../ambient-blob'

interface ScoredAgent {
  key: string
  name: string
  score: number
  winner?: boolean
}

const AGENTS: ScoredAgent[] = [
  { key: 'twap', name: 'TWAP Agent', score: 89.6 },
  { key: 'momentum', name: 'Momentum Agent', score: 86.3 },
  { key: 'shadow', name: 'Shadow Agent', score: 97.8, winner: true },
  { key: 'arbitrage', name: 'Arbitrage Agent', score: 94.1 },
]

const SUBMIT_ORDER = AGENTS.map((a) => a.key)
const RANKED_ORDER = [...AGENTS].sort((a, b) => b.score - a.score).map((a) => a.key)
const BY_KEY = Object.fromEntries(AGENTS.map((a) => [a.key, a]))

export function ExecutionScoreScene() {
  const [cycleId, setCycleId] = useState(0)
  const [order, setOrder] = useState(SUBMIT_ORDER)
  const [scores, setScores] = useState<Record<string, number>>({})
  const [ranked, setRanked] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
      timeouts.push(t)
    }

    setOrder(SUBMIT_ORDER)
    setScores({})
    setRanked(false)

    AGENTS.forEach((agent, i) => {
      schedule(() => {
        const steps = 22
        for (let s = 1; s <= steps; s++) {
          schedule(() => {
            setScores((prev) => ({
              ...prev,
              [agent.key]: Number(((agent.score / steps) * s).toFixed(1)),
            }))
          }, s * 20)
        }
      }, i * 150)
    })

    schedule(() => {
      setRanked(true)
      setOrder(RANKED_ORDER)
    }, 1700)

    schedule(() => setCycleId((c) => c + 1), 5200)

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
    }
  }, [cycleId])

  return (
    <div
      className="relative h-[340px] w-full overflow-hidden rounded-2xl md:h-[380px]"
      style={{ background: '#e8e8ec' }}
    >
      <AmbientBlob color="rgba(99,102,241,0.32)" size={210} top="12%" left="4%" duration={12} />
      <AmbientBlob
        color="rgba(200,150,90,0.22)"
        size={160}
        bottom="10%"
        right="4%"
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
          left: '18%',
        }}
      />
      <div className="relative z-10 flex h-full w-full flex-col justify-center gap-2 p-5 md:p-6">
        {order.map((key) => {
          const agent = BY_KEY[key]!
          const score = scores[key] ?? 0
          const isWinner = ranked && Boolean(agent.winner)

          return (
            <motion.div
              key={key}
              layout
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            >
              {isWinner ? (
                <GlassPanel borderRadius={14}>
                  <div className="px-3.5 py-2.5">
                    <ScoreRow agent={agent} score={score} isWinner />
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.2, duration: 0.3 }}
                      className="mt-1 font-sans text-[10px] text-black/40"
                    >
                      +2.3% better than baseline
                    </motion.div>
                  </div>
                </GlassPanel>
              ) : (
                <div className="px-3.5 py-2.5">
                  <ScoreRow agent={agent} score={score} isWinner={false} />
                </div>
              )}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function ScoreRow({
  agent,
  score,
  isWinner,
}: {
  agent: ScoredAgent
  score: number
  isWinner: boolean
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-sans text-[11px] font-medium text-[#111]">
          {agent.name}
          {isWinner && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 14 }}
              className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#111] text-white"
            >
              <Check className="h-2.5 w-2.5" strokeWidth={3} />
            </motion.span>
          )}
        </span>
        <span className="font-sans text-[11px] tabular-nums text-black/40">{score.toFixed(1)}</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-black/[0.06]">
        <motion.div
          className={`h-full rounded-full ${isWinner ? 'bg-black/50' : 'bg-black/20'}`}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        />
      </div>
    </>
  )
}
