'use client'

import { cn } from '@intent/ui'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { agentGradient } from '../../lib/agents/identity'
import type { LeaderboardRow } from '../../lib/agents/leaderboard'
import { rankAgents } from '../../lib/agents/leaderboard'
import { loadTurns, onTurnsChanged, syncTurns } from '../../lib/chat-history'
import { useChain, useChainHref } from '../../providers/chain-provider'
import { AgentAvatar } from './agent-avatar'

/**
 * Agents ranked by races won, counted from this user's own history.
 *
 * Reads the local cache first so the board does not blank, then syncs from
 * the server and re-renders on any later change.
 */
export function AgentLeaderboard(): JSX.Element {
  const { slug } = useChain()
  const chainHref = useChainHref()
  const [rows, setRows] = useState<LeaderboardRow[]>(() => rankAgents(loadTurns(slug)))

  useEffect(() => {
    setRows(rankAgents(loadTurns(slug)))
    void syncTurns(slug).then((turns) => setRows(rankAgents(turns)))
    return onTurnsChanged(() => setRows(rankAgents(loadTurns(slug))))
  }, [slug])

  if (rows.length === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-sm">
        No races yet. Run an intent and the agents that answer appear here.
      </div>
    )
  }

  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div className="border-border text-muted-foreground grid grid-cols-[2rem_1fr_5rem_5rem_5rem] items-center gap-4 border-b px-5 py-3 text-xs sm:grid-cols-[2rem_1fr_6rem_6rem_6rem]">
        <span>#</span>
        <span>Agent</span>
        <span className="text-right">Wins</span>
        <span className="text-right">Races</span>
        <span className="text-right">Win rate</span>
      </div>
      {rows.map((row, i) => (
        <Link
          key={row.key}
          href={chainHref(`/agents/${encodeURIComponent(row.key)}`)}
          className={cn(
            'border-border grid grid-cols-[2rem_1fr_5rem_5rem_5rem] items-center gap-4 px-5 py-4 transition-colors last:border-b-0 sm:grid-cols-[2rem_1fr_6rem_6rem_6rem]',
            'hover:bg-muted/40 border-b',
            i === 0 && 'border-foreground/30 border-l-2'
          )}
        >
          <span
            className={cn(
              'text-sm tabular-nums',
              i === 0 ? 'text-foreground font-semibold' : 'text-muted-foreground'
            )}
          >
            {i + 1}
          </span>
          <div className="flex min-w-0 items-center gap-3">
            <AgentAvatar gradient={agentGradient(row.key)} name={row.name} className="h-8 w-8" />
            <span className="text-foreground truncate text-sm font-medium">{row.name}</span>
          </div>
          <span className="text-foreground text-right text-sm font-semibold tabular-nums">
            {row.wins}
          </span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">{row.races}</span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">
            {Math.round(row.winRate * 100)}%
          </span>
        </Link>
      ))}
    </div>
  )
}
