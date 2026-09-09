'use client'

import { useEffect, useRef, useState } from 'react'

import type { CompetitionPhase, CompetitionState } from './use-mock-competition'
import type { AgentProposalView } from '../lib/mock-competition'
import { DECIDE_AT, RACE_DURATION, REVEAL_DELAYS, WINDOW_SECONDS } from '../lib/mock-competition'
import { decodeFrame } from '../lib/agents/events'
import { planDecision, planReveal } from '../lib/agents/pacing'
import { STRATEGIES, STRATEGY_ORDER } from '../lib/agents/strategies'
import type { ParsedIntent } from '../lib/parse-intent'

/**
 * Runs a competition against the agent route, returning the same shape as the
 * offline hook so the panel does not care which one is driving it.
 *
 * Cards reveal on a floor rather than a fixed timer — see `lib/agents/pacing.ts`
 * for why.
 */
export interface CompetitionWithRoute extends CompetitionState {
  /**
   * The winning agent's chosen route, when it chose one.
   *
   * Carried through from the winner frame so the confirm step offers the exact
   * quote the competition was decided on, rather than re-pricing and showing
   * the user a different number than the agents compared.
   */
  route?: unknown
}

export function useCompetition(
  parsed: ParsedIntent | null,
  chain: string
): CompetitionWithRoute {
  const [proposals, setProposals] = useState<Record<string, AgentProposalView>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [phase, setPhase] = useState<CompetitionPhase>('idle')
  const [secondsLeft, setSecondsLeft] = useState(WINDOW_SECONDS)
  const [winner, setWinner] = useState<string | null>(null)
  const [route, setRoute] = useState<unknown>(undefined)
  const lastRevealRef = useRef(0)

  useEffect(() => {
    if (parsed === null) {
      setProposals({})
      setRevealed({})
      setPhase('idle')
      setSecondsLeft(WINDOW_SECONDS)
      setWinner(null)
      setRoute(undefined)
      return
    }

    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const abort = new AbortController()
    const startedAt = Date.now()
    lastRevealRef.current = 0

    const schedule = (fn: () => void, ms: number): void => {
      timeouts.push(
        setTimeout(() => {
          if (!cancelled) fn()
        }, ms)
      )
    }

    setProposals({})
    setRevealed({})
    setPhase('competing')
    setSecondsLeft(WINDOW_SECONDS)
    setWinner(null)

    // The countdown is cosmetic: a 30-second window compressed into the race
    // duration, matching the original animation.
    let raf = 0
    const tick = (): void => {
      if (cancelled) return
      const elapsed = Date.now() - startedAt
      setSecondsLeft(Math.ceil(Math.max(0, WINDOW_SECONDS - (elapsed / RACE_DURATION) * WINDOW_SECONDS)))
      if (elapsed < RACE_DURATION) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    async function run(): Promise<void> {
      try {
        const res = await fetch('/api/agents/compete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: parsed?.outcome ?? '', chain }),
          signal: abort.signal,
        })

        if (!res.ok || res.body === null) throw new Error(`compete failed (${res.status})`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done || cancelled) break

          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split('\n\n')
          // The trailing element is an incomplete frame; keep it for next read.
          buffer = chunks.pop() ?? ''

          for (const chunk of chunks) {
            const line = chunk.replace(/^data: /, '').trim()
            if (line === '') continue
            const frame = decodeFrame(line)
            if (frame === undefined) continue

            if (frame.type === 'competition:proposal') {
              const key = frame.proposal.strategy
              const order = STRATEGIES[key].revealOrder
              const floor = REVEAL_DELAYS[order] ?? 0
              const { revealAtMs, delayMs } = planReveal(floor, Date.now() - startedAt)
              lastRevealRef.current = Math.max(lastRevealRef.current, revealAtMs)

              setProposals((prev) => ({
                ...prev,
                [key]: {
                  key,
                  name: STRATEGIES[key].name,
                  avgPriceUsd: frame.proposal.projectedAvgPriceUsd,
                  slippagePct: frame.proposal.projectedSlippagePct,
                  score: 0,
                  reasoning: frame.proposal.reasoning,
                  degraded: frame.degraded,
                },
              }))
              schedule(() => setRevealed((prev) => ({ ...prev, [key]: true })), delayMs)
            }

            if (frame.type === 'competition:winner') {
              const winnerKey = frame.winner
              const scores = frame.scores
              if (frame.route !== undefined) setRoute(frame.route)
              setProposals((prev) => {
                const next = { ...prev }
                for (const [key, score] of Object.entries(scores)) {
                  const existing = next[key]
                  if (existing !== undefined) next[key] = { ...existing, score }
                }
                return next
              })
              schedule(
                () => {
                  setWinner(winnerKey)
                  setPhase('decided')
                },
                Math.max(0, planDecision(DECIDE_AT, lastRevealRef.current) - (Date.now() - startedAt))
              )
            }
          }
        }
      } catch {
        // A dead route should not leave the UI stuck mid-race. Reveal whatever
        // arrived and let the panel settle.
        if (cancelled) return
        for (const key of STRATEGY_ORDER) {
          setRevealed((prev) => ({ ...prev, [key]: true }))
        }
        setPhase('decided')
      }
    }

    void run()

    return () => {
      cancelled = true
      abort.abort()
      cancelAnimationFrame(raf)
      for (const t of timeouts) clearTimeout(t)
    }
  }, [parsed, chain])

  return {
    proposals,
    revealed,
    phase,
    secondsLeft,
    winner,
    ...(route !== undefined ? { route } : {}),
  }
}
