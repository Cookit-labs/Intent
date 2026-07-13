'use client'

import { cn } from '@intent/ui'
import { useState } from 'react'

import { AgentDirectory } from '../../components/agents/agent-directory'
import { AgentLeaderboard } from '../../components/agents/agent-leaderboard'

type Tab = 'directory' | 'leaderboard'

const TABS: { id: Tab; label: string }[] = [
  { id: 'directory', label: 'Directory' },
  { id: 'leaderboard', label: 'Leaderboard' },
]

export default function AgentsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('directory')

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Agents</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Solver agents that compete to fill your intents. Browse, rank, and connect your own.
        </p>
      </div>

      <div className="border-border mb-8 flex items-center gap-6 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-1 pb-3 text-sm transition-colors',
              tab === t.id
                ? 'border-foreground text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'directory' ? <AgentDirectory /> : <AgentLeaderboard />}
    </div>
  )
}
