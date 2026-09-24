'use client'

import { IntentChat } from '../../../components/intents/intent-chat'

/**
 * The composer, and only the composer.
 *
 * History used to sit behind a second tab here, which hid a whole page of
 * settled trades and open positions behind a label most people never
 * clicked. It has its own page now, one step away in the sidebar.
 */
export default function IntentsPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Intents</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Say what you want. Agents compete to deliver it.
        </p>
      </div>

      <IntentChat />
    </div>
  )
}
