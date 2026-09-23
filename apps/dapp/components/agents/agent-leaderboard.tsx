'use client'

import { cn } from '@intent/ui'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { agentGradient } from '../../lib/agents/identity'
import type { Confidence, RankedAgent } from '../../lib/agents/ranking'
import {
  countRankableRaces,
  minimumRacesForRanking,
  rankPositions,
  rankWithConfidence,
  rankingIsMeaningful,
} from '../../lib/agents/ranking'
import type { ChatTurn } from '../../lib/chat-history'
import { loadTurns, onTurnsChanged, syncTurns } from '../../lib/chat-history'
import { useChain, useChainHref } from '../../providers/chain-provider'
import { AgentAvatar } from './agent-avatar'

/**
 * Agents rated from this user's own races, with the uncertainty shown.
 *
 * The board used to order agents by wins. Seven models race, and a handful
 * of races cannot order seven agents, so that order was mostly noise
 * presented as a standing. It now shows a Bradley–Terry rating with a
 * bootstrap interval (see `lib/agents/ranking.ts`), refuses to rank until
 * there are enough races, and says when two agents cannot be told apart.
 *
 * Reads the local cache first so the board does not blank, then syncs from
 * the server and re-renders on any later change.
 */

interface Board {
  rows: RankedAgent[]
  positions: number[]
  meaningful: boolean
  races: number
}

function board(turns: ChatTurn[]): Board {
  const rows = rankWithConfidence(turns)
  return {
    rows,
    positions: rankPositions(rows),
    meaningful: rankingIsMeaningful(turns),
    races: countRankableRaces(turns),
  }
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: 'too few races',
  low: 'low confidence',
  medium: 'moderate confidence',
  high: 'high confidence',
}

const GRID = 'grid-cols-[2rem_1fr_7rem_4rem_4rem] sm:grid-cols-[2rem_1fr_9rem_5rem_5rem]'

export function AgentLeaderboard(): JSX.Element {
  const { slug } = useChain()
  const chainHref = useChainHref()
  const [state, setState] = useState<Board>(() => board(loadTurns(slug)))

  useEffect(() => {
    setState(board(loadTurns(slug)))
    void syncTurns(slug).then((turns) => setState(board(turns)))
    return onTurnsChanged(() => setState(board(loadTurns(slug))))
  }, [slug])

  const { rows, positions, meaningful, races } = state

  if (rows.length === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-sm">
        No races yet. Run an intent and the agents that answer appear here.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {!meaningful ? (
        <div className="border-border text-muted-foreground rounded-xl border border-dashed px-5 py-3 text-sm">
          Not enough races to rank yet — {races} of at least {minimumRacesForRanking}. Wins and
          races are counted below; the order is not a standing.
        </div>
      ) : null}

      <div className="border-border overflow-hidden rounded-xl border">
        <div
          className={cn(
            'border-border text-muted-foreground grid items-center gap-4 border-b px-5 py-3 text-xs',
            GRID
          )}
        >
          <span>#</span>
          <span>Agent</span>
          <span className="text-right">Rating</span>
          <span className="text-right">Wins</span>
          <span className="text-right">Races</span>
        </div>
        {rows.map((row, i) => {
          const leader = meaningful && i === 0
          const sharesRank = meaningful && i > 0 && positions[i] === positions[i - 1]
          return (
            <Link
              key={row.key}
              href={chainHref(`/agents/${encodeURIComponent(row.key)}`)}
              className={cn(
                'border-border grid items-center gap-4 px-5 py-4 transition-colors last:border-b-0',
                'hover:bg-muted/40 border-b',
                GRID,
                leader && 'border-foreground/30 border-l-2'
              )}
            >
              <span
                className={cn(
                  'text-sm tabular-nums',
                  leader ? 'text-foreground font-semibold' : 'text-muted-foreground'
                )}
              >
                {meaningful ? positions[i] : '–'}
              </span>
              <div className="flex min-w-0 items-center gap-3">
                <AgentAvatar
                  gradient={agentGradient(row.key)}
                  name={row.name}
                  className="h-8 w-8"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="text-foreground truncate text-sm font-medium">{row.name}</span>
                  {sharesRank ? (
                    <span className="text-muted-foreground text-xs">
                      shares rank — intervals overlap
                    </span>
                  ) : null}
                </div>
              </div>
              {meaningful ? (
                <RatingCell row={row} />
              ) : (
                <span className="text-muted-foreground text-right text-sm tabular-nums">–</span>
              )}
              <span className="text-foreground text-right text-sm font-semibold tabular-nums">
                {row.wins}
              </span>
              <span className="text-muted-foreground text-right text-sm tabular-nums">
                {row.races}
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The rating with half its 95% interval, and a label in plain words.
 *
 * The interval is not symmetric, so the exact bounds are on the tooltip;
 * the ± figure is enough to read whether two rows can be told apart.
 */
function RatingCell({ row }: { row: RankedAgent }): JSX.Element {
  const halfWidth = Math.round((row.high - row.low) / 2)
  return (
    <div
      className="flex flex-col items-end gap-1"
      title={`95% interval ${Math.round(row.low)}–${Math.round(row.high)}`}
    >
      <span className="text-foreground text-sm font-semibold tabular-nums">
        {Math.round(row.rating)}
        <span className="text-muted-foreground ml-1 text-xs font-normal">±{halfWidth}</span>
      </span>
      <span
        className={cn(
          'border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]',
          row.confidence === 'none' && 'border-dashed',
          row.confidence === 'high' && 'bg-foreground text-background border-transparent'
        )}
      >
        {CONFIDENCE_LABEL[row.confidence]}
      </span>
    </div>
  )
}
