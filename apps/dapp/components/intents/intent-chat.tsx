'use client'

import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { useCompetition } from '../../hooks/use-competition'
import { useCreateIntent } from '../../hooks/use-intent'
import { useMockCompetition } from '../../hooks/use-mock-competition'
import { parseIntent, type ParsedIntent } from '../../lib/parse-intent'
import { CompetitionPanel } from './competition-panel'
import { SwapConfirm } from './swap-confirm'
import { useSwapExecution } from '../../hooks/use-swap-execution'
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
  const { slug } = useChain()

  // Agents run through the route only when explicitly enabled. The offline race
  // stays the default so a checkout with no configuration behaves as before.
  const useAgents = process.env['NEXT_PUBLIC_USE_AI'] === 'true'
  const live = useCompetition(useAgents ? parsed : null, slug)
  const offline = useMockCompetition(useAgents ? null : parsed)
  const competition = useAgents ? live : offline

  // Only the live path produces an executable route; the offline race has
  // nothing to sign.
  const swap = useSwapExecution(useAgents ? live.route : undefined)

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
      <div className="border-border relative flex shrink-0 items-center border-b px-4 py-3">
        <TrafficLights />
        <span className="text-muted-foreground absolute left-1/2 -translate-x-1/2 text-xs">
          Live settlement
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
          <div className="flex flex-col gap-4">
            <div className="flex justify-end">
              <div className="bg-foreground text-background max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                {message}
              </div>
            </div>
            <CompetitionPanel
              state={competition}
              onExecute={handleExecute}
              executingKey={executingKey}
            />

            {/* Appears only once an agent has won with an executable route, so
                the race is never interrupted by a confirmation prompt. */}
            <SwapConfirm
              phase={swap.phase}
              quote={swap.quote}
              sendDisplay={swap.sendDisplay}
              receiveDisplay={swap.receiveDisplay}
              hash={swap.hash}
              explorerUrl={swap.explorerUrl}
              error={swap.error}
              usdPrices={swap.usdPrices}
              onConfirm={swap.confirm}
              onReset={swap.reset}
            />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-border shrink-0 border-t p-3">
        <ComposerInput
          onSubmit={handleSubmit}
          showExamples={!parsed}
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
