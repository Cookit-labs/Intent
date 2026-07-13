'use client'

import { Plus, Terminal } from 'lucide-react'
import Link from 'next/link'

import { AGENT_PROFILES, formatVolumeUsd, type AgentProfile } from '../../lib/agent-roster'
import { AgentAvatar } from './agent-avatar'

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground text-sm font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  )
}

function AgentRow({ agent }: { agent: AgentProfile }): JSX.Element {
  return (
    <Link
      href={`/agents/${agent.key}`}
      className="border-border hover:border-foreground/40 flex flex-col gap-4 rounded-xl border p-5 transition-colors"
    >
      <div className="flex items-center gap-3">
        <AgentAvatar gradient={agent.gradient} name={agent.name} className="h-10 w-10" />
        <div className="flex flex-1 flex-col">
          <span className="text-foreground text-sm font-semibold">{agent.name}</span>
          <span className="text-muted-foreground text-xs">
            {agent.handle} · {agent.tag}
          </span>
        </div>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span
            className={
              agent.status === 'active'
                ? 'bg-foreground h-1.5 w-1.5 rounded-full'
                : 'bg-muted-foreground h-1.5 w-1.5 rounded-full'
            }
          />
          {agent.status === 'active' ? 'Active' : 'Idle'}
        </span>
      </div>

      <p className="text-muted-foreground text-sm leading-relaxed">{agent.blurb}</p>

      <div className="border-border grid grid-cols-3 gap-4 border-t pt-4">
        <Stat label="Reputation" value={String(agent.reputation)} />
        <Stat label="Win rate" value={`${Math.round(agent.winRate * 100)}%`} />
        <Stat label="Volume" value={formatVolumeUsd(agent.volumeUsd)} />
      </div>
    </Link>
  )
}

function RegisterCard(): JSX.Element {
  return (
    <div className="border-border flex flex-col gap-3 rounded-xl border border-dashed p-5">
      <span className="border-border text-foreground flex h-10 w-10 items-center justify-center rounded-full border">
        <Plus className="h-5 w-5" />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-foreground text-sm font-semibold">Register an agent</span>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Connect a solver to compete on intents. Publish a strategy endpoint, stake reputation, and
          start bidding.
        </p>
      </div>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          className="bg-foreground text-background rounded-full px-4 py-2 text-sm transition-opacity hover:opacity-90"
        >
          Register agent
        </button>
        <button
          type="button"
          className="border-border text-foreground hover:border-foreground/40 flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm transition-colors"
        >
          <Terminal className="h-4 w-4" /> Dev docs
        </button>
      </div>
    </div>
  )
}

export function AgentDirectory(): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {AGENT_PROFILES.map((agent) => (
        <AgentRow key={agent.key} agent={agent} />
      ))}
      <RegisterCard />
    </div>
  )
}
