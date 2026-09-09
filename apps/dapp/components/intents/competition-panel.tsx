'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Loader2, Radio } from 'lucide-react'

import type { CompetitionState } from '../../hooks/use-mock-competition'
import { AGENTS } from '../../lib/mock-competition'

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
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function CompetitionPanel({
  state,
  onExecute,
  executingKey,
}: {
  state: CompetitionState
  onExecute: (key: string) => void
  executingKey: string | null
}): JSX.Element {
  const { proposals, revealed, phase, winner } = state
  const decided = phase === 'decided'
  const revealedAgents = AGENTS.filter((a) => revealed[a.key])
  // Agents answer independently and slowly — tens of seconds each. The panel
  // used to show a "broadcasting" line only while *nothing* had arrived, so as
  // soon as the first agent replied every sign of activity vanished and the
  // screen sat motionless while the rest were still working. That reads as a
  // crash, not as progress.
  const pendingAgents = decided ? [] : AGENTS.filter((a) => !revealed[a.key])

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
          const isWinner = decided && winner === agent.key
          const dimmed = decided && !isWinner
          const isExecuting = executingKey === agent.key
          return (
            <motion.div
              key={agent.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: dimmed ? 0.55 : 1, y: 0 }}
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
                  'flex-1 rounded-2xl rounded-tl-sm border p-4',
                  isWinner ? 'border-brand' : 'border-border'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{agent.name}</span>
                    <span className="text-muted-foreground text-xs">{agent.tag}</span>
                  </div>
                  {isWinner ? (
                    <span className="bg-foreground text-background flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                      <Bot className="h-3 w-3" />
                      Recommended
                    </span>
                  ) : null}
                </div>

                <p className="text-foreground mt-2 text-sm">
                  {proposal?.reasoning ?? agent.reasoning}
                </p>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="bg-muted text-foreground rounded-full px-2.5 py-1 font-mono text-xs tabular-nums">
                    {money(proposal?.avgPriceUsd ?? 0)} avg ·{' '}
                    {(proposal?.slippagePct ?? agent.slippagePct).toFixed(2)}% slip
                  </span>
                  <button
                    type="button"
                    onClick={() => onExecute(agent.key)}
                    disabled={executingKey !== null}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
                      isWinner
                        ? 'bg-foreground text-background hover:bg-foreground/90'
                        : 'border-border text-foreground hover:border-foreground/40 border'
                    )}
                  >
                    {isExecuting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Execute
                  </button>
                </div>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>

      {/* One placeholder per agent still thinking, named so the wait is
          legible: the user can see who is outstanding rather than wondering
          whether anything is still happening. */}
      {pendingAgents.map((agent) => (
        <div key={`pending-${agent.key}`} className="flex items-start gap-3">
          <span
            className="mt-0.5 h-9 w-9 shrink-0 animate-pulse rounded-full opacity-40 motion-reduce:animate-none"
            style={{ backgroundImage: agent.gradient }}
            aria-hidden
          />
          <div className="border-border flex-1 rounded-2xl rounded-tl-sm border border-dashed p-4">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{agent.name}</span>
              <span className="text-muted-foreground text-xs">{agent.tag}</span>
            </div>
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

      {decided && Object.values(proposals).some((p) => p.degraded) ? (
        <p className="text-muted-foreground mt-1 text-center text-[11px]">
          Simulated proposals — live agents unavailable.
        </p>
      ) : null}

      {decided && winner ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-border mx-auto mt-1 flex items-center gap-2 rounded-full border px-3 py-1.5"
        >
          <span className="bg-muted text-muted-foreground flex h-5 w-5 items-center justify-center rounded-full">
            <Bot className="h-3 w-3" />
          </span>
          <span className="text-muted-foreground text-xs">
            System recommends {proposals[winner]?.name} — strongest strategy. You pick who executes.
          </span>
        </motion.div>
      ) : null}
    </div>
  )
}
