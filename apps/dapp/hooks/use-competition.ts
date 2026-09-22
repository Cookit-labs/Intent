'use client'

import { useEffect, useRef, useState } from 'react'

import type {
  AgentProposalView,
  CompetingAgent,
  CompetitionError,
  CompetitionPhase,
  CompetitionState,
} from '../lib/agents/competition'
import { DECIDE_AT, RACE_DURATION, WINDOW_SECONDS, revealFloor } from '../lib/agents/competition'
import { decodeFrame } from '../lib/agents/events'
import { planDecision, planReveal } from '../lib/agents/pacing'
import type { ParsedIntent } from '../lib/parse-intent'

/**
 * How long to wait before giving up on the stream entirely.
 *
 * Comfortably past the route's 60s-per-agent ceiling: this catches a
 * connection that has stopped delivering without failing. Past this point the
 * agents that have not answered are marked as not having answered — not
 * filled in, not left thinking.
 */
const STREAM_TIMEOUT_MS = 120_000

/**
 * Runs a competition against the agent route.
 *
 * There is no offline mode. When the route reports that no agent is live, or
 * the chain cannot be executed on, or nobody answered, the state carries an
 * `error` and the panel shows it. A placeholder race used to run here instead,
 * with canned proposals that named venues from another chain — it read as
 * agents having decided something, and nothing about it could be executed.
 */
export interface CompetitionWithRoute extends CompetitionState {
  /** The winning agent's chosen route, when it chose one. */
  route?: unknown
  /**
   * Each agent's own route, keyed by strategy.
   *
   * The user picks who executes, so the winner's route is not enough: without
   * these, choosing any other agent silently signed the winner's trade.
   */
  routesByAgent: Record<string, unknown>
}

export function useCompetition(parsed: ParsedIntent | null, chain: string): CompetitionWithRoute {
  const [proposals, setProposals] = useState<Record<string, AgentProposalView>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [phase, setPhase] = useState<CompetitionPhase>('idle')
  const [secondsLeft, setSecondsLeft] = useState(WINDOW_SECONDS)
  const [winner, setWinner] = useState<string | null>(null)
  const [unanimous, setUnanimous] = useState(false)
  const [error, setError] = useState<CompetitionError | undefined>(undefined)
  const [route, setRoute] = useState<unknown>(undefined)
  const [routesByAgent, setRoutesByAgent] = useState<Record<string, unknown>>({})
  const [agents, setAgents] = useState<CompetingAgent[]>([])
  // The same list, readable inside the stream loop's closures without a
  // stale render's copy.
  const agentsRef = useRef<CompetingAgent[]>([])
  const lastRevealRef = useRef(0)

  useEffect(() => {
    if (parsed === null) {
      setProposals({})
      setRevealed({})
      setPhase('idle')
      setSecondsLeft(WINDOW_SECONDS)
      setWinner(null)
      setUnanimous(false)
      setError(undefined)
      setRoute(undefined)
      setRoutesByAgent({})
      setAgents([])
      agentsRef.current = []
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

    /** An agent that produced nothing gets a card saying so, never a placeholder. */
    const markFailed = (key: string, reason: AgentProposalView['failed']): void => {
      setProposals((prev) =>
        prev[key] !== undefined && prev[key]?.failed === undefined
          ? prev
          : {
              ...prev,
              [key]: {
                key,
                name: agentsRef.current.find((a) => a.key === key)?.name ?? key,
                avgPriceUsd: 0,
                vsOraclePct: 0,
                score: 0,
                failed: reason ?? 'timeout',
              },
            }
      )
      setRevealed((prev) => ({ ...prev, [key]: true }))
    }

    /** Ends the race: everything unanswered is marked, and the panel settles. */
    const settle = (): void => {
      for (const { key, name, model } of agentsRef.current) {
        setProposals((prev) => {
          if (prev[key] !== undefined) return prev
          return {
            ...prev,
            [key]: {
              key,
              name,
              model,
              avgPriceUsd: 0,
              vsOraclePct: 0,
              score: 0,
              failed: 'timeout',
            },
          }
        })
        setRevealed((prev) => ({ ...prev, [key]: true }))
      }
      setPhase('decided')
    }

    setProposals({})
    setRevealed({})
    setPhase('competing')
    setSecondsLeft(WINDOW_SECONDS)
    setWinner(null)
    setUnanimous(false)
    setError(undefined)
    // Stale routes from the previous intent would otherwise still be
    // executable, signing a trade the user is no longer looking at.
    setRoute(undefined)
    setRoutesByAgent({})
    setAgents([])
    agentsRef.current = []

    // A stream that stalls without erroring would leave the panel waiting on
    // agents that will never answer. Past this point it is not slowness but a
    // connection that is not coming back, and the user is owed an ending.
    timeouts.push(
      setTimeout(() => {
        if (cancelled) return
        abort.abort()
        settle()
      }, STREAM_TIMEOUT_MS)
    )

    // The countdown is cosmetic: a 30-second window compressed into the race
    // duration, matching the original animation.
    let raf = 0
    const tick = (): void => {
      if (cancelled) return
      const elapsed = Date.now() - startedAt
      setSecondsLeft(
        Math.ceil(Math.max(0, WINDOW_SECONDS - (elapsed / RACE_DURATION) * WINDOW_SECONDS))
      )
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

            if (frame.type === 'competition:error') {
              // The race is over before it began, or produced nothing. Said
              // as such: no cards, no placeholders, one message.
              setError({ code: frame.code, message: frame.message })
              setPhase('decided')
              abort.abort()
              return
            }

            if (frame.type === 'competition:started') {
              // Named while the cards still say "thinking", so the line-up is
              // visible before any of it has answered.
              agentsRef.current = frame.agents
              setAgents(frame.agents)
              continue
            }

            if (frame.type === 'competition:failed') {
              markFailed(frame.agent, frame.error)
              continue
            }

            if (frame.type === 'competition:proposal') {
              const key = frame.proposal.agent
              const agent = agentsRef.current.find((a) => a.key === key)
              const index = agentsRef.current.findIndex((a) => a.key === key)
              const floor = revealFloor(Math.max(0, index))
              const { revealAtMs, delayMs } = planReveal(floor, Date.now() - startedAt)
              lastRevealRef.current = Math.max(lastRevealRef.current, revealAtMs)

              if (frame.route !== undefined) {
                setRoutesByAgent((prev) => ({ ...prev, [key]: frame.route }))
              }
              const source = (frame.route as { source?: unknown } | undefined)?.source

              setProposals((prev) => ({
                ...prev,
                [key]: {
                  key,
                  name: agent?.name ?? key,
                  ...(agent !== undefined ? { model: agent.model } : {}),
                  // Measured by the server from the route, not claimed by the
                  // agent. See lib/agents/measure.ts.
                  avgPriceUsd: frame.proposal.projectedAvgPriceUsd,
                  vsOraclePct: frame.proposal.projectedSlippagePct,
                  score: 0,
                  reasoning: frame.proposal.reasoning,
                  ...(typeof source === 'string' ? { source } : {}),
                  sliceCount: frame.proposal.sliceCount,
                  horizonMinutes: frame.proposal.horizonMinutes,
                  executionMode: frame.proposal.executionMode,
                  ...(frame.proposal.restPriceUsd !== undefined
                    ? { restPriceUsd: frame.proposal.restPriceUsd }
                    : {}),
                  ...(frame.proposal.splitPct !== undefined
                    ? { splitPct: frame.proposal.splitPct }
                    : {}),
                  ...(frame.proposal.thenAction !== undefined
                    ? { thenAction: frame.proposal.thenAction }
                    : {}),
                  ...(frame.proposal.thenVenue !== undefined
                    ? { thenVenue: frame.proposal.thenVenue }
                    : {}),
                },
              }))
              schedule(() => setRevealed((prev) => ({ ...prev, [key]: true })), delayMs)
            }

            if (frame.type === 'competition:winner') {
              const winnerKey = frame.winner
              const scores = frame.scores
              setUnanimous(frame.unanimous === true)
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
                  settle()
                },
                Math.max(
                  0,
                  planDecision(DECIDE_AT, lastRevealRef.current) - (Date.now() - startedAt)
                )
              )
            }
          }
        }

        // The stream ended without a winner or an error frame — every agent
        // failed and the server said nothing further, or the connection was
        // cut. Either way, whatever has not answered is marked and the race
        // ends rather than waiting on nothing.
        if (!cancelled) settle()
      } catch {
        if (cancelled) return
        settle()
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
    agents,
    phase,
    secondsLeft,
    winner,
    unanimous,
    routesByAgent,
    ...(error !== undefined ? { error } : {}),
    ...(route !== undefined ? { route } : {}),
  }
}
