'use client'

import { Plus, Terminal } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { PublicAgent } from '../../lib/agents/registry'
import { useChainHref } from '../../providers/chain-provider'
import { AgentAvatar } from './agent-avatar'

/**
 * The agents that will race, as the server has them configured.
 *
 * Read from the roster endpoint rather than a table in this bundle: an agent
 * is a model, and which models are wired in is a deployment's decision. The
 * card shows what a reader can act on — who serves it and whether it costs —
 * and nothing that would have to be invented.
 */
function AgentRow({ agent }: { agent: PublicAgent }): JSX.Element {
  const chainHref = useChainHref()
  return (
    <Link
      href={chainHref(`/agents/${encodeURIComponent(agent.key)}`)}
      className="border-border hover:border-foreground/40 flex flex-col gap-4 rounded-xl border p-5 transition-colors"
    >
      <div className="flex items-center gap-3">
        <AgentAvatar gradient={agent.gradient} name={agent.name} className="h-10 w-10" />
        <div className="flex flex-1 flex-col">
          <span className="text-foreground text-sm font-semibold">{agent.name}</span>
          <span className="text-muted-foreground text-xs">via {agent.providerName}</span>
        </div>
        <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
          {agent.free ? 'free' : 'paid'}
        </span>
      </div>
      <span className="text-muted-foreground truncate font-mono text-xs">{agent.model}</span>
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

type Roster =
  | { status: 'loading' }
  | { status: 'ready'; agents: PublicAgent[] }
  | { status: 'failed'; message: string }

export function AgentDirectory(): JSX.Element {
  const [roster, setRoster] = useState<Roster>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch('/api/agents/roster')
      .then(async (res) => {
        if (!res.ok) throw new Error(`roster failed (${res.status})`)
        return (await res.json()) as { agents: PublicAgent[] }
      })
      .then((body) => {
        if (!cancelled) setRoster({ status: 'ready', agents: body.agents })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRoster({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {roster.status === 'loading' ? (
        <div className="text-muted-foreground text-sm">Loading the roster…</div>
      ) : roster.status === 'failed' ? (
        <div className="text-muted-foreground text-sm">
          Could not load the roster: {roster.message}
        </div>
      ) : roster.agents.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          No agents configured. Set a provider key.
        </div>
      ) : (
        roster.agents.map((agent) => <AgentRow key={agent.key} agent={agent} />)
      )}
      <RegisterCard />
    </div>
  )
}
