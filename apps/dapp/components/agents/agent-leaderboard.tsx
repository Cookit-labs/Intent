'use client'

import { cn } from '@intent/ui'
import Link from 'next/link'

import { AGENT_RANKING, formatCount, formatVolumeUsd } from '../../lib/agent-roster'
import { AgentAvatar } from './agent-avatar'

export function AgentLeaderboard(): JSX.Element {
  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div className="border-border text-muted-foreground grid grid-cols-[2rem_1fr_5rem_5rem_5rem] items-center gap-4 border-b px-5 py-3 text-xs sm:grid-cols-[2rem_1fr_6rem_6rem_6rem]">
        <span>#</span>
        <span>Agent</span>
        <span className="text-right">Rep</span>
        <span className="text-right">Win rate</span>
        <span className="text-right">Fills</span>
      </div>
      {AGENT_RANKING.map((agent, i) => (
        <Link
          key={agent.key}
          href={`/agents/${agent.key}`}
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
            <AgentAvatar gradient={agent.gradient} name={agent.name} className="h-8 w-8" />
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground truncate text-sm font-medium">{agent.name}</span>
              <span className="text-muted-foreground truncate text-xs">
                {formatVolumeUsd(agent.volumeUsd)} volume
              </span>
            </div>
          </div>
          <span className="text-foreground text-right text-sm font-semibold tabular-nums">
            {agent.reputation}
          </span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">
            {Math.round(agent.winRate * 100)}%
          </span>
          <span className="text-muted-foreground text-right text-sm tabular-nums">
            {formatCount(agent.fills)}
          </span>
        </Link>
      ))}
    </div>
  )
}
