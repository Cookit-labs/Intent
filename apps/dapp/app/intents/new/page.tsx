import type { Metadata } from 'next'

import { IntentChat } from '../../../components/intents/intent-chat'

export const metadata: Metadata = { title: 'New intent' }

export default function NewIntentPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Submit an intent</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Declare the outcome you want. Autonomous agents compete to beat it — you settle in USDC on
          Arc.
        </p>
      </div>
      <IntentChat />
    </div>
  )
}
