import { Badge, PageHeader } from '@intent/ui'

import { CompetitionChart } from '../../components/analytics/competition-chart'
import { SlippageChart } from '../../components/analytics/slippage-chart'
import { VolumeChart } from '../../components/analytics/volume-chart'

export default function AnalyticsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Analytics"
        description="Volume, slippage, and competition trends. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <VolumeChart />
        <SlippageChart />
        <CompetitionChart />
      </div>
    </div>
  )
}
