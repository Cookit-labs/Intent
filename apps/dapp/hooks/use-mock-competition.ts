'use client'

import { useEffect, useMemo, useState } from 'react'

import {
  AGENTS,
  DECIDE_AT,
  RACE_DURATION,
  WINDOW_SECONDS,
  buildProposals,
  winnerKey,
} from '../lib/mock-competition'
import type { AgentProposalView } from '../lib/mock-competition'
import type { ParsedIntent } from '../lib/parse-intent'

export type CompetitionPhase = 'idle' | 'competing' | 'decided'

export interface CompetitionState {
  proposals: Record<string, AgentProposalView>
  revealed: Record<string, boolean>
  phase: CompetitionPhase
  secondsLeft: number
  winner: string | null
}

/**
 * Drives a mock agent competition for a submitted intent: agents reveal their
 * proposals on staggered timers within a fixed window, then a winner is chosen.
 * Mirrors the timing of the website how-it-works agent race.
 */
export function useMockCompetition(parsed: ParsedIntent | null): CompetitionState {
  const proposals = useMemo(() => (parsed ? buildProposals(parsed) : {}), [parsed])
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [phase, setPhase] = useState<CompetitionPhase>('idle')
  const [secondsLeft, setSecondsLeft] = useState(WINDOW_SECONDS)
  const [winner, setWinner] = useState<string | null>(null)

  useEffect(() => {
    if (!parsed) {
      setRevealed({})
      setPhase('idle')
      setSecondsLeft(WINDOW_SECONDS)
      setWinner(null)
      return
    }

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
    setSecondsLeft(WINDOW_SECONDS)
    setWinner(null)

    const start = performance.now()
    let rafId = requestAnimationFrame(function tick(now) {
      if (cancelled) return
      const elapsed = now - start
      const remaining = Math.max(0, WINDOW_SECONDS - (elapsed / RACE_DURATION) * WINDOW_SECONDS)
      setSecondsLeft(Math.ceil(remaining))
      if (elapsed < RACE_DURATION) rafId = requestAnimationFrame(tick)
    })

    AGENTS.forEach((agent) => {
      schedule(() => setRevealed((r) => ({ ...r, [agent.key]: true })), agent.revealAt)
    })
    schedule(() => {
      setPhase('decided')
      setWinner(winnerKey())
    }, DECIDE_AT)

    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
      cancelAnimationFrame(rafId)
    }
  }, [parsed])

  return { proposals, revealed, phase, secondsLeft, winner }
}
