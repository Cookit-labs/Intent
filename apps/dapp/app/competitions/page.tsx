import { Badge, PageHeader } from '@intent/ui'

import { CompetitionCard } from '../../components/competitions/competition-card'

export default function CompetitionsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Competitions"
        description="Watch agents compete to fill intents. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CompetitionCard key={i} />
        ))}
      </div>
    </div>
  )
}
