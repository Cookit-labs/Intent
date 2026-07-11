'use client'

import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useCreateIntent } from '../../hooks/use-intent'
import { useMockCompetition } from '../../hooks/use-mock-competition'
import { parseIntent, type ParsedIntent } from '../../lib/parse-intent'
import { CompetitionPanel } from './competition-panel'
import { ComposerInput } from './composer-input'

export function IntentChat(): JSX.Element {
  const router = useRouter()
  const createIntent = useCreateIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const [executingKey, setExecutingKey] = useState<string | null>(null)
  const competition = useMockCompetition(parsed)

  function handleSubmit(text: string): void {
    setMessage(text)
    setParsed(parseIntent(text))
    setExecutingKey(null)
  }

  function handleReset(): void {
    setMessage(null)
    setParsed(null)
    setExecutingKey(null)
  }

  function handleExecute(key: string): void {
    if (!parsed || executingKey) return
    setExecutingKey(key)
    createIntent.mutate(parsed.input, {
      onSuccess: (created) => router.push(`/intents/${created.id}`),
      onError: () => setExecutingKey(null),
    })
  }

  if (!parsed || !message) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="border-border text-foreground flex h-11 w-11 items-center justify-center rounded-full border">
            <Sparkles className="h-5 w-5" />
          </span>
          <p className="text-muted-foreground max-w-md text-sm">
            Skip the order form. Say what you want to happen — autonomous agents compete to find the
            best execution, and you pick who executes.
          </p>
        </div>
        <ComposerInput onSubmit={handleSubmit} showExamples />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <CompetitionPanel state={competition} onExecute={handleExecute} executingKey={executingKey} />

      <ComposerInput
        key={message}
        initialText={message}
        onSubmit={handleSubmit}
        onReset={handleReset}
      />

      {createIntent.isError ? (
        <p className="text-foreground text-sm">
          {(createIntent.error as Error).message || 'Something went wrong. No funds moved.'}
        </p>
      ) : null}
    </div>
  )
}
