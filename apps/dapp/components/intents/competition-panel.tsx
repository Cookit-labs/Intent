'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Crown, Loader2, Radio, TriangleAlert, WifiOff } from 'lucide-react'

import type { CompetitionState } from '../../lib/agents/competition'
import { describePlan } from '../../lib/agents/competition'
import { AgentAvatar } from '../agents/agent-avatar'
import { agentBubble, systemPill } from './bubble'

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
          className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-reduce:animate-none"
          animate={{ y: [0, -3, 0], opacity: [0.35, 0.9, 0.35] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
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

/**
 * The model id, short enough to sit beside a name.
 *
 * Providers publish these in three shapes — `qwen/qwen3.8-27b`,
 * `qwen3.5:latest`, `deepseek-v4-flash` — and only the last part identifies
 * the model. The vendor prefix and the `:latest` tag say nothing a reader
 * needs.
 */
function shortModel(model: string | undefined): string {
  if (model === undefined || model === '') return ''
  const withoutVendor = model.includes('/') ? (model.split('/').pop() ?? model) : model
  return withoutVendor.replace(/:latest$/, '')
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
  const { proposals, revealed, agents, phase, winner, error } = state
  const unanimous = state.unanimous === true

  // Nothing to show until something is running. The panel used to paint
  // "Broadcasting…" and four "thinking…" placeholders whenever the phase was
  // anything but decided — including idle — so any message that opened the
  // thread without a trade (a supply, a borrow, a standing rule) sat above a
  // race that was not happening and never ended.
  if (phase === 'idle') return null

  if (error !== undefined) {
    return (
      <div className={cn(agentBubble, 'flex items-start gap-3 border-dashed')}>
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 opacity-60" />
        <div>
          <p className="font-medium">
            {error.code === 'chain_unsupported'
              ? 'Agents cannot execute here'
              : error.code === 'no_agent_answered'
                ? 'No agent answered'
                : 'Agents are not online'}
          </p>
          <p className="mt-1 opacity-70">{error.message}</p>
        </div>
      </div>
    )
  }

  const decided = phase === 'decided'
  const revealedAgents = agents.filter((a) => revealed[a.key])
  const pendingAgents = decided ? [] : agents.filter((a) => !revealed[a.key])
  const anyAnswered = Object.values(proposals).some((p) => p.failed === undefined)

  return (
    <div className="flex flex-col gap-4">
      {revealedAgents.length === 0 && !decided ? (
        <div className={systemPill}>
          <Radio className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none" />
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
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: dimmed || failed ? 0.6 : 1, y: 0, scale: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="flex flex-col gap-1"
            >
              <div className="text-muted-foreground ml-11 flex flex-wrap items-center gap-x-1.5 text-xs">
                <span className="text-foreground font-semibold">{agent.name}</span>
                {/* Which model actually answered. Shown because four
                    agents reaching the same conclusion means something
                    different when they are one model than when they are
                    three, and the user cannot tell those apart otherwise. */}
                {shortModel(agent.model) !== '' ? (
                  <span className="opacity-70">· {shortModel(agent.model)}</span>
                ) : null}
                {isWinner ? (
                  <span className="bg-brand text-brand-foreground ml-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
                    <Crown className="h-3 w-3" />
                    Recommended
                  </span>
                ) : null}
              </div>

              <div className="flex items-end gap-2.5">
                <AgentAvatar seed={agent.key} name={agent.name} className="h-8 w-8" />

                {failed ? (
                  <div
                    className={cn(
                      agentBubble,
                      'flex items-center gap-2 border-dashed bg-transparent shadow-none'
                    )}
                  >
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="opacity-75">
                      {failureText(proposal?.failed ?? 'upstream_error')} Nothing to review.
                    </span>
                  </div>
                ) : (
                  <div
                    className={cn(
                      agentBubble,
                      'flex-1 transition-shadow',
                      isExecuting
                        ? 'ring-brand ring-2'
                        : isWinner
                          ? 'ring-brand/50 ring-1'
                          : undefined
                    )}
                  >
                    {/* What this agent proposed, not what it "is". The tag is
                        derived from the proposal, so it cannot contradict it. */}
                    {tag !== '' ? (
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-55">
                        {tag}
                      </p>
                    ) : null}
                    <p className="leading-relaxed">{proposal?.reasoning}</p>

                    {/* Why the score fell short, in the plan's own terms. A number
                        that drops with no stated reason reads as arbitrary, which
                        is the thing the tie-break hash was rightly criticised for.
                        Each line names the figures it was judged on. */}
                    {(proposal?.penalties ?? []).length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1">
                        {(proposal?.penalties ?? []).map((p) => (
                          <li
                            key={p.reason}
                            className="flex items-start gap-1.5 text-xs opacity-70"
                          >
                            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>
                              {p.detail} <span className="tabular-nums">&minus;{p.points}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="border-bubble-agent-foreground/10 mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                      {/* Measured from the route, not reported by the agent:
                          what a unit cost, and how that compares with the
                          oracle's fair value. */}
                      <div className="flex flex-col text-xs tabular-nums">
                        <span className="font-semibold">
                          {money(proposal?.avgPriceUsd ?? 0)} avg
                        </span>
                        <span className="opacity-60">
                          {[
                            vsOracle(proposal?.vsOraclePct),
                            proposal?.executionMode === 'rest' &&
                            proposal.horizonMinutes !== undefined &&
                            proposal.horizonMinutes > 0
                              ? `over ${proposal.horizonMinutes}m`
                              : '',
                          ]
                            .filter((s) => s !== '')
                            .join(' · ')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onExecute(agent.key)}
                        disabled={locked}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
                          isExecuting || isWinner
                            ? 'bg-brand text-brand-foreground hover:bg-brand/90'
                            : 'border-bubble-agent-foreground/15 hover:bg-bubble-agent-foreground/5 border'
                        )}
                      >
                        {locked && isExecuting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {isExecuting ? 'Selected' : 'Review'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>

      {pendingAgents.map((agent) => (
        <div key={`pending-${agent.key}`} className="flex flex-col gap-1">
          <div className="text-muted-foreground ml-11 text-xs">
            <span className="text-foreground font-semibold">{agent.name}</span>
            {shortModel(agent.model) !== '' ? (
              <span className="opacity-70"> · {shortModel(agent.model)}</span>
            ) : null}
          </div>
          <div className="flex items-end gap-2.5">
            <AgentAvatar seed={agent.key} name={agent.name} className="h-8 w-8" pending />
            <div
              className={cn(agentBubble, 'flex w-fit items-center px-4 py-3')}
              role="status"
              aria-label={`${agent.name} is thinking`}
            >
              <ThinkingDots />
            </div>
          </div>
        </div>
      ))}

      {decided && winner !== null && anyAnswered ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={systemPill}
        >
          {/* Recommended on the measured fill, which is the only thing scored.
              "Strongest strategy" implied a judgement of the reasoning; there
              is none — the route's real output decides, and a tie is broken
              by a draw the agents cannot influence. */}
          {unanimous
            ? `All ${Object.values(proposals).filter((p) => p.failed === undefined).length} agents agree — ${describePlan(proposals[winner] ?? {})}. Pick any to execute.`
            : `Recommended: ${proposals[winner]?.name} — best measured fill. You pick who executes.`}
        </motion.div>
      ) : null}
    </div>
  )
}
