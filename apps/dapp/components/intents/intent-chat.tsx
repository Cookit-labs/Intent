'use client'

import { cn } from '@intent/ui'
import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useCreateIntent } from '../../hooks/use-intent'
import { useMockCompetition } from '../../hooks/use-mock-competition'
import { WINDOW_SECONDS } from '../../lib/mock-competition'
import { parseIntent, type ParsedIntent } from '../../lib/parse-intent'
import { CompetitionPanel } from './competition-panel'
import { ComposerInput } from './composer-input'

function TrafficLights(): JSX.Element {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      <span className="h-3 w-3 rounded-full" style={{ background: '#ff5f57' }} />
      <span className="h-3 w-3 rounded-full" style={{ background: '#febc2e' }} />
      <span className="h-3 w-3 rounded-full" style={{ background: '#28c840' }} />
    </div>
  )
}

export function IntentChat(): JSX.Element {
  const router = useRouter()
  const createIntent = useCreateIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const [executingKey, setExecutingKey] = useState<string | null>(null)
  const competition = useMockCompetition(parsed)

  const live = competition.phase === 'competing'
  const timer = String(Math.min(competition.secondsLeft, WINDOW_SECONDS)).padStart(2, '0')

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

  return (
    <div className="border-border bg-card flex h-[70vh] max-h-[720px] min-h-[520px] flex-col overflow-hidden rounded-2xl border">
      {/* Window chrome */}
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <TrafficLights />
        <span className="text-muted-foreground text-xs">Live settlement</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              live
                ? 'bg-foreground animate-pulse motion-reduce:animate-none'
                : 'bg-muted-foreground'
            )}
          />
          00:{competition.phase === 'decided' ? '00' : timer}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {!parsed || !message ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="border-border text-foreground flex h-11 w-11 items-center justify-center rounded-full border">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="text-muted-foreground max-w-sm text-sm">
              Say what you want to happen. Autonomous agents compete to find the best execution —
              you pick who executes.
            </p>
          </div>
        ) : (
          <CompetitionPanel
            state={competition}
            onExecute={handleExecute}
            executingKey={executingKey}
          />
        )}
      </div>

      {/* Composer */}
      <div className="border-border shrink-0 border-t p-3">
        <ComposerInput
          key={message ?? 'idle'}
          onSubmit={handleSubmit}
          showExamples={!parsed}
          {...(message ? { initialText: message } : {})}
          {...(parsed ? { onReset: handleReset } : {})}
        />
        {createIntent.isError ? (
          <p className="text-foreground mt-2 text-xs">
            {(createIntent.error as Error).message || 'Something went wrong. No funds moved.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}
