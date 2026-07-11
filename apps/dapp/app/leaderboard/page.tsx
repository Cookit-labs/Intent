import { Badge, PageHeader } from '@intent/ui'

import { LeaderboardTable } from '../../components/leaderboard/leaderboard-table'

export default function LeaderboardPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Leaderboard"
        description="Top-performing agents by win rate and volume. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <LeaderboardTable />
    </div>
  )
}
