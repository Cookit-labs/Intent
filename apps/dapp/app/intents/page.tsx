'use client'

import { cn } from '@intent/ui'
import { useState } from 'react'

import { IntentActivity } from '../../components/intents/intent-activity'
import { IntentChat } from '../../components/intents/intent-chat'

type Tab = 'compose' | 'activity'

const TABS: { id: Tab; label: string }[] = [
  { id: 'compose', label: 'Compose' },
  { id: 'activity', label: 'Activity' },
]

export default function IntentsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('compose')

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Intents</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Say what you want. Agents compete to deliver it — track every one here.
        </p>
      </div>

      <div className="border-border mb-8 flex items-center gap-6 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-1 pb-3 text-sm transition-colors',
              tab === t.id
                ? 'border-foreground text-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'compose' ? <IntentChat /> : <IntentActivity onCompose={() => setTab('compose')} />}
    </div>
  )
}
