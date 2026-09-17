'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Loader2, Radio, TriangleAlert, WifiOff } from 'lucide-react'

import type { CompetitionState } from '../../lib/agents/competition'
import { AGENTS, describePlan } from '../../lib/agents/competition'

/**
 * Three dots that keep moving while an agent reasons.
 *
 * Staggered rather than blinking together so the motion reads as ongoing work.
 * Reduced-motion users get static dots — the placeholder's presence already
 * carries the meaning, so the animation is decoration.
 */
function ThinkingDots(): JSX.Element {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/60 h-1.5 w-1.5 rounded-full motion-reduce:animate-none"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
        />
      ))}
    </span>
  )
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

/**
 * The fill's distance from fair value, in words a person can read.
 *
 * Negative is better than the oracle — common on testnet, where synthetic
 * liquidity is often mispriced against the real feed — and it is said as
 * "better", not shown as a minus sign that reads like an error.
 */
function vsOracle(pct: number | undefined): string {
  if (pct === undefined || !Number.isFinite(pct)) return ''
  const abs = Math.abs(pct)
  if (abs < 0.05) return 'at oracle'
  return pct < 0 ? `${abs.toFixed(1)}% better than oracle` : `${abs.toFixed(1)}% worse than oracle`
}

function failureText(code: string): string {
  switch (code) {
    case 'timeout':
      return 'This agent did not answer in time.'
    case 'rate_limited':
      return 'The model rate-limited this agent.'
    case 'invalid_schema':
    case 'refused':
      return 'This agent gave an answer that could not be used.'
    case 'no_api_key':
      return 'This agent is not configured.'
    default:
      return 'This agent could not be reached.'
  }
}

export function CompetitionPanel({
  state,
  onExecute,
  executingKey,
  locked = false,
}: {
  state: CompetitionState
  onExecute: (key: string) => void
  executingKey: string | null
  /**
   * True once a signature is with the wallet or the network.
   *
   * Selection stays open until then: picking an agent is not a commitment, and
   * disabling the buttons on the first pick made it one.
   */
  locked?: boolean
}): JSX.Element | null {
  const { proposals, revealed, phase, winner, error } = state
  const unanimous = state.unanimous === true

  // Nothing to show until something is running. The panel used to paint
  // "Broadcasting…" and four "thinking…" placeholders whenever the phase was
  // anything but decided — including idle — so any message that opened the
  // thread without a trade (a supply, a borrow, a standing rule) sat above a
  // race that was not happening and never ended.
  if (phase === 'idle') return null

  if (error !== undefined) {
    return (
      <div className="border-border flex items-start gap-3 rounded-2xl border border-dashed p-4">
        <WifiOff className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-sm font-medium">
            {error.code === 'chain_unsupported'
              ? 'Agents cannot execute here'
              : error.code === 'no_agent_answered'
                ? 'No agent answered'
                : 'Agents are not online'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{error.message}</p>
        </div>
      </div>
    )
  }

  const decided = phase === 'decided'
  const revealedAgents = AGENTS.filter((a) => revealed[a.key])
  const pendingAgents = decided ? [] : AGENTS.filter((a) => !revealed[a.key])
  const anyAnswered = Object.values(proposals).some((p) => p.failed === undefined)

  return (
    <div className="flex flex-col gap-3">
      {revealedAgents.length === 0 && !decided ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Radio className="h-4 w-4 animate-pulse motion-reduce:animate-none" />
          Broadcasting to the agent network…
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {revealedAgents.map((agent) => {
          const proposal = proposals[agent.key]
          const failed = proposal?.failed !== undefined
          // No crown on a draw. When the agents agree, none of them "won" —
          // marking one as recommended over identical proposals is the thing
          // that makes the same name look favoured race after race.
          const isWinner = decided && !unanimous && winner === agent.key
          const isExecuting = executingKey === agent.key
          const dimmed = decided && !unanimous && !isWinner && !isExecuting
          const tag = proposal !== undefined ? describePlan(proposal) : ''

          return (
            <motion.div
              key={agent.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: dimmed || failed ? 0.55 : 1, y: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex items-start gap-3"
            >
              <span
                className="mt-0.5 h-9 w-9 shrink-0 rounded-full"
                style={{ backgroundImage: agent.gradient }}
                aria-hidden
              />
              <div
                className={cn(
                  'flex-1 rounded-2xl rounded-tl-sm border p-4 transition-colors',
                  failed
                    ? 'border-border border-dashed'
                    : isExecuting
                      ? 'border-foreground ring-foreground/20 ring-1'
                      : isWinner
                        ? 'border-brand'
                        : 'border-border'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{agent.name}</span>
                    {/* What this agent proposed, not what it "is". The tag is
                        derived from the proposal, so it cannot contradict it. */}
                    {tag !== '' ? (
                      <span className="text-muted-foreground text-xs">{tag}</span>
                    ) : null}
                  </div>
                  {failed ? (
                    <span className="border-border text-muted-foreground flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px]">
                      <TriangleAlert className="h-3 w-3" />
                      Did not respond
                    </span>
                  ) : isWinner ? (
                    <span className="bg-foreground text-background flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                      <Bot className="h-3 w-3" />
                      Recommended
                    </span>
                  ) : null}
                </div>

                {failed ? (
                  <p className="text-muted-foreground mt-2 text-sm">
                    {failureText(proposal?.failed ?? 'upstream_error')} Nothing was proposed, so
                    there is nothing to review.
                  </p>
                ) : (
                  <>
                    <p className="text-foreground mt-2 text-sm">{proposal?.reasoning}</p>

                    <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                      {proposal?.executionMode === 'rest' &&
                      proposal.horizonMinutes !== undefined &&
                      proposal.horizonMinutes > 0 ? (
                        <span>over {proposal.horizonMinutes}m</span>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
                      {/* Measured from the route, not reported by the agent:
                          what a unit cost, and how that compares with the
                          oracle's fair value. */}
                      <span className="bg-muted text-foreground rounded-full px-2.5 py-1 font-mono text-xs tabular-nums">
                        {money(proposal?.avgPriceUsd ?? 0)} avg
                        {vsOracle(proposal?.vsOraclePct) !== ''
                          ? ` · ${vsOracle(proposal?.vsOraclePct)}`
                          : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => onExecute(agent.key)}
                        disabled={locked}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
                          isExecuting || isWinner
                            ? 'bg-foreground text-background hover:bg-foreground/90'
                            : 'border-border text-foreground hover:border-foreground/40 border'
                        )}
                      >
                        {locked && isExecuting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {isExecuting ? 'Selected' : 'Review'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>

      {pendingAgents.map((agent) => (
        <div key={`pending-${agent.key}`} className="flex items-start gap-3">
          <span
            className="mt-0.5 h-9 w-9 shrink-0 animate-pulse rounded-full opacity-40 motion-reduce:animate-none"
            style={{ backgroundImage: agent.gradient }}
            aria-hidden
          />
          <div className="border-border flex-1 rounded-2xl rounded-tl-sm border border-dashed p-4">
            <span className="text-sm font-semibold">{agent.name}</span>
            <div
              className="mt-2 flex items-center gap-1.5"
              role="status"
              aria-label={`${agent.name} is thinking`}
            >
              <ThinkingDots />
              <span className="text-muted-foreground text-xs">thinking…</span>
            </div>
          </div>
        </div>
      ))}

      {decided && winner !== null && anyAnswered ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-border mx-auto mt-1 flex items-center gap-2 rounded-full border px-3 py-1.5"
        >
          <span className="bg-muted text-muted-foreground flex h-5 w-5 items-center justify-center rounded-full">
            <Bot className="h-3 w-3" />
          </span>
          {/* Recommended on the measured fill, which is the only thing scored.
              "Strongest strategy" implied a judgement of the reasoning; there
              is none — the route's real output decides, and a tie is broken
              by a draw the agents cannot influence. */}
          <span className="text-muted-foreground text-xs">
            {unanimous
              ? `All ${Object.values(proposals).filter((p) => p.failed === undefined).length} agents agree — ${describePlan(proposals[winner] ?? {})}. Pick any to execute.`
              : `Recommended: ${proposals[winner]?.name} — best measured fill. You pick who executes.`}
          </span>
        </motion.div>
      ) : null}
    </div>
  )
}
