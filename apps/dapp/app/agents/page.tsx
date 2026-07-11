import { Badge, PageHeader } from '@intent/ui'

import { AgentCard } from '../../components/agents/agent-card'

export default function AgentsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Agents"
        description="Solver agents that compete to fill intents. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <AgentCard key={i} />
        ))}
      </div>
    </div>
  )
}
