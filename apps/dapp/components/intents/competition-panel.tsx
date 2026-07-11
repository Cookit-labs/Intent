'use client'

import { Badge, Button, Card } from '@intent/ui'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2, Radio } from 'lucide-react'

import type { CompetitionState } from '../../hooks/use-mock-competition'
import { AGENTS, RACE_DURATION, WINDOW_SECONDS } from '../../lib/mock-competition'
import type { ParsedIntent } from '../../lib/parse-intent'

function Equalizer(): JSX.Element {
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

function CountdownRing({ seconds }: { seconds: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground font-mono text-xs tabular-nums">
        00:{String(seconds).padStart(2, '0')}
      </span>
      <div className="relative flex h-8 w-8 items-center justify-center">
        <svg viewBox="0 0 36 36" className="absolute h-8 w-8 -rotate-90">
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth="2.5"
          />
          <motion.circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            stroke="hsl(var(--foreground))"
            strokeWidth="2.5"
            strokeLinecap="round"
            initial={{ pathLength: 1 }}
            animate={{ pathLength: 0 }}
            transition={{ duration: RACE_DURATION / 1000, ease: 'linear' }}
          />
        </svg>
        <span className="font-mono text-[10px] font-semibold tabular-nums">{seconds}</span>
      </div>
    </div>
  )
}

export function CompetitionPanel({
  parsed,
  state,
  onAccept,
  accepting,
}: {
  parsed: ParsedIntent
  state: CompetitionState
  onAccept: () => void
  accepting: boolean
}): JSX.Element {
  const { proposals, revealed, phase, secondsLeft, winner } = state
  const decided = phase === 'decided'
  const winnerProposal = winner ? proposals[winner] : undefined

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="text-muted-foreground h-4 w-4" />
          <span className="text-sm font-medium">
            {decided ? 'Best execution selected' : 'Agents competing'}
          </span>
        </div>
        {decided ? (
          <Badge variant="outline">Winner</Badge>
        ) : (
          <CountdownRing seconds={Math.min(secondsLeft, WINDOW_SECONDS)} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        {AGENTS.map((agent) => {
          const isRevealed = Boolean(revealed[agent.key])
          const isWinner = decided && winner === agent.key
          const dimmed = decided && !isWinner
          const proposal = proposals[agent.key]

          return (
            <motion.div
              key={agent.key}
              animate={{ opacity: dimmed ? 0.45 : 1 }}
              transition={{ duration: 0.4 }}
              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                isWinner ? 'border-foreground/50' : 'border-border'
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  {agent.name}
                  {isWinner ? (
                    <span className="bg-foreground text-background flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                      Recommended
                    </span>
                  ) : null}
                </div>
                {!isRevealed ? (
                  <div className="text-muted-foreground truncate text-xs">{agent.reasoning}</div>
                ) : (
                  <div className="text-muted-foreground font-mono text-[11px]">
                    {agent.strategyType} strategy
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
                    className="text-right"
                  >
                    <div className="font-mono text-xs font-medium tabular-nums">
                      {proposal?.projectedOut} {proposal?.tokenOut}
                    </div>
                    <div className="text-muted-foreground font-mono text-[10px] tabular-nums">
                      {proposal?.slippagePct.toFixed(2)}% slip
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          )
        })}
      </div>

      <AnimatePresence>
        {decided && winnerProposal ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="border-border flex flex-col gap-3 rounded-lg border p-4"
          >
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Recommended execution</span>
              <span className="font-mono font-medium tabular-nums">
                {winnerProposal.projectedOut} {winnerProposal.tokenOut} ·{' '}
                {winnerProposal.slippagePct.toFixed(2)}% slip
              </span>
            </div>
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>{parsed.escrowUsd.toLocaleString()} USDC escrowed · settles on Arc</span>
              <span>{winnerProposal.name} agent</span>
            </div>
            <Button
              onClick={onAccept}
              disabled={accepting}
              size="lg"
              className="bg-foreground text-background hover:bg-foreground/90"
            >
              {accepting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
                </>
              ) : (
                'Accept & settle'
              )}
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Card>
  )
}
