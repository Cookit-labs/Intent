'use client'

import { cn } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Loader2, Radio } from 'lucide-react'

import type { CompetitionState } from '../../hooks/use-mock-competition'
import { AGENTS } from '../../lib/mock-competition'

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

  return (
    <div className="flex flex-col gap-3">
      {revealedAgents.length === 0 ? (
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

                <p className="text-foreground mt-2 text-sm">{agent.reasoning}</p>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="bg-muted text-foreground rounded-full px-2.5 py-1 font-mono text-xs tabular-nums">
                    {money(proposal?.avgPriceUsd ?? 0)} avg · {agent.slippagePct.toFixed(2)}% slip
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
