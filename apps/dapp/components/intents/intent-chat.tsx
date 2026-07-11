'use client'

import { Badge, Card } from '@intent/ui'
import { motion } from 'framer-motion'
import { Radio, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useCreateIntent } from '../../hooks/use-intent'
import { useMockCompetition } from '../../hooks/use-mock-competition'
import { intentTypeLabel } from '../../lib/intent-format'
import { parseIntent, type ParsedIntent } from '../../lib/parse-intent'
import { ComposerInput } from './composer-input'
import { CompetitionPanel } from './competition-panel'

export function IntentChat(): JSX.Element {
  const router = useRouter()
  const createIntent = useCreateIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const competition = useMockCompetition(parsed)

  function handleSubmit(text: string): void {
    setMessage(text)
    setParsed(parseIntent(text))
  }

  function handleAccept(): void {
    if (!parsed) return
    createIntent.mutate(parsed.input, {
      onSuccess: (created) => router.push(`/intents/${created.id}`),
    })
  }

  if (!parsed || !message) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="bg-brand/10 text-brand flex h-11 w-11 items-center justify-center rounded-full">
            <Sparkles className="h-5 w-5" />
          </span>
          <p className="text-muted-foreground max-w-md text-sm">
            Skip the order form. Say what you want to happen — autonomous agents compete to find the
            best execution, and you pick the winner.
          </p>
        </div>
        <ComposerInput onSubmit={handleSubmit} showExamples />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* User intent bubble */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex justify-end"
      >
        <div className="bg-brand text-brand-foreground max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
          {message}
        </div>
      </motion.div>

      {/* Assistant: intent understood */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <Card className="flex flex-col gap-3 p-4">
          <span className="text-brand font-mono text-[11px] uppercase tracking-widest">
            Intent understood
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{intentTypeLabel(parsed.input.type)}</Badge>
            <Badge variant="outline">{parsed.escrowUsd.toLocaleString()} USDC escrowed</Badge>
            <Badge variant="outline">Target {parsed.input.tokenOut}</Badge>
          </div>
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Radio className="text-brand h-3 w-3" />
            Broadcasting to the agent network
            <motion.span
              className="bg-brand h-1.5 w-1.5 rounded-full"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
            />
          </div>
        </Card>
      </motion.div>

      {/* Live competition */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <CompetitionPanel
          parsed={parsed}
          state={competition}
          onAccept={handleAccept}
          accepting={createIntent.isPending}
        />
      </motion.div>

      {createIntent.isError ? (
        <p className="text-destructive text-sm">
          {(createIntent.error as Error).message || 'Something went wrong. No funds moved.'}
        </p>
      ) : null}
    </div>
  )
}
