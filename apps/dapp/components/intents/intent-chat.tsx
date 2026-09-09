'use client'

import { Sparkles } from 'lucide-react'
import { useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { useCompetition } from '../../hooks/use-competition'
import { useCancelIntent, useCreateIntent } from '../../hooks/use-intent'
import { useWallet } from '../../hooks/use-wallet'
import { checkAffordability } from '../../lib/affordability'
import { fetchStellarBalances } from '../../lib/stellar-account'
import { useQuery } from '@tanstack/react-query'
import { OpenIntentCard } from './open-intent-card'
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
  const createIntent = useCreateIntent()
  const cancelIntent = useCancelIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const [executingKey, setExecutingKey] = useState<string | null>(null)
  // The intent placed in this conversation, so an order that is waiting for a
  // price can be watched — and withdrawn — without leaving the chat.
  const [placedId, setPlacedId] = useState<string | null>(null)
  const [affordError, setAffordError] = useState<string | null>(null)
  const { slug } = useChain()
  const { address, isConnected } = useWallet()

  // Balances, so an order can be checked against what the account actually
  // holds before it is placed rather than after it fails.
  const { data: balances } = useQuery({
    queryKey: ['stellar-balances', address],
    queryFn: () => fetchStellarBalances(address as string),
    enabled: slug === 'stellar' && isConnected && address !== undefined,
    staleTime: 15_000,
  })

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
    // Parsed against the same live prices the server uses. Without them this
    // fell back to an indicative table that had XLM at $0.58 against a real
    // ~$0.18, so the same sentence produced one size here and a different one
    // in the competition.
    setParsed(parseIntent(text, swap.usdPrices))
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
  }

  function handleReset(): void {
    setMessage(null)
    setParsed(null)
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
  }

  function handleExecute(key: string): void {
    if (!parsed || executingKey) return

    // Refuse an order the account cannot fund. Without this a wallet holding
    // $12 could open a $4,000 limit order, which the app then displayed as a
    // live position for hours — an order that could only ever fail.
    if (slug === 'stellar') {
      const afford = checkAffordability(parsed.input.amountIn, parsed.input.tokenIn, balances)
      if (!afford.ok) {
        setAffordError(afford.message)
        return
      }
    }
    setAffordError(null)
    setExecutingKey(key)

    // Every intent is recorded, whichever way it goes. Skipping the record for
    // signable routes kept the user in the chat but left the trade out of
    // history entirely, so an executed limit buy simply never appeared.
    // The limit price travels with the intent. Parsed but never stored, it was
    // discarded at creation — so a limit order became indistinguishable from a
    // market order the moment it was placed, and filled immediately.
    const isLimit =
      parsed.input.type === 'limit_buy' ||
      parsed.input.type === 'limit_sell' ||
      parsed.input.type === 'accumulate'
    const input = {
      ...parsed.input,
      chain: slug,
      ...(isLimit && parsed.targetPriceUsd > 0 ? { limitPriceUsd: parsed.targetPriceUsd } : {}),
    }

    // Everything stays in the conversation. The competition, the winner, the
    // signature and a resting order all belong to one thread — sending the
    // user to a detail page broke it in two, scrolling the agents' reasoning
    // away exactly when it was being acted on.
    createIntent.mutate(input, {
      onSuccess: (created) => setPlacedId(created.id),
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

            {/* Said before anything is signed. An order the account cannot
                fund is refused here rather than allowed to rest for hours and
                then fail. */}
            {affordError !== null ? (
              <div className="border-border rounded-2xl border border-dashed p-4">
                <p className="text-foreground text-sm">{affordError}</p>
              </div>
            ) : null}

            {/* A resting order lives in the thread that placed it, with its
                own cancel — the same conversation, not a separate page. */}
            {placedId !== null ? (
              <OpenIntentCard
                intentId={placedId}
                onCancel={(id) => cancelIntent.mutate(id)}
                cancelling={cancelIntent.isPending}
                cancelError={
                  cancelIntent.isError ? (cancelIntent.error as Error).message : undefined
                }
              />
            ) : null}

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
