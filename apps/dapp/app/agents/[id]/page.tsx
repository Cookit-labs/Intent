import { Badge, PageHeader } from '@intent/ui'

import { ReputationChart } from '../../../components/agents/reputation-chart'

export default function AgentDetailPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Agent"
        title="Agent profile"
        description="Reputation, win rate, and execution history. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <ReputationChart />
    </div>
  )
}
