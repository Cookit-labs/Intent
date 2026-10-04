import { isChainSlug } from '@intent/config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { IntentChat } from '../../../../components/intents/intent-chat'
import { intentIntro } from '../../../../lib/intent-intro-copy'

export const metadata: Metadata = { title: 'New intent' }

export default function NewIntentPage({ params }: { params: { chain: string } }): JSX.Element {
  if (!isChainSlug(params.chain)) notFound()

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Submit an intent</h1>
        <p className="text-muted-foreground mt-1 text-sm">{intentIntro(params.chain)}</p>
      </div>
      <IntentChat />
    </div>
  )
}
