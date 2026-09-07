import { Badge, Card, PageHeader, Skeleton } from '@intent/ui'

export default function SettingsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Settings"
        description="Preferences, network, and approval controls. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <Card className="flex flex-col gap-4 p-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </Card>
    </div>
  )
}
