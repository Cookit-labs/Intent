import { Badge, Card, PageHeader, Skeleton } from '@intent/ui'

export default function HistoryPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="History"
        description="Your settled and cancelled intents. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <Card className="flex flex-col gap-3 p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  )
}
