'use client'

import { Button, Card } from '@intent/ui'
import { Plus } from 'lucide-react'
import Link from 'next/link'

import { IntentCard } from '../../components/intents/intent-card'
import { useIntents } from '../../hooks/use-intent'

export default function IntentsPage(): JSX.Element {
  const { data: intents, isLoading, isError, error } = useIntents()

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Intents</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Your submitted outcomes and their live status.
          </p>
        </div>
        <Button asChild>
          <Link href="/intents/new">
            <Plus className="h-4 w-4" /> New intent
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="bg-muted/40 h-24 animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <Card className="text-destructive p-6 text-sm">
          Failed to load intents: {(error as Error).message}
        </Card>
      ) : intents && intents.length > 0 ? (
        <div className="flex flex-col gap-3">
          {intents.map((intent) => (
            <IntentCard key={intent.id} intent={intent} />
          ))}
        </div>
      ) : (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <p className="text-muted-foreground text-sm">No intents yet.</p>
          <Button asChild>
            <Link href="/intents/new">
              <Plus className="h-4 w-4" /> Submit your first intent
            </Link>
          </Button>
        </Card>
      )}
    </div>
  )
}
