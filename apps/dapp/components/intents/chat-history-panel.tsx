'use client'

import { cn } from '@intent/ui'
import { ExternalLink, Plus, X } from 'lucide-react'

import { stellarTestnet } from '@intent/config'
import type { ChatTurn } from '../../lib/chat-history'

/**
 * Past conversations, opened from the clock in the chat header.
 *
 * Sits over the conversation rather than replacing it, so glancing at an
 * earlier intent does not discard the one in progress. Selecting a turn
 * reopens it in the chat.
 */

function when(iso: string): string {
  const then = new Date(iso).getTime()
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ChatHistoryPanel({
  turns,
  onSelect,
  onClose,
  onClear,
  onNew,
}: {
  turns: ChatTurn[]
  onSelect: (turn: ChatTurn) => void
  onClose: () => void
  onClear: () => void
  /**
   * Starts an empty conversation without discarding this one.
   *
   * Lives here rather than in the header because it belongs to the same idea
   * as the list: these are the conversations you have, and this adds another.
   */
  onNew: () => void
}): JSX.Element {
  return (
    <div className="bg-card absolute inset-0 z-20 flex flex-col">
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold">Past intents</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onNew}
            className="border-border hover:border-foreground/40 hover:bg-muted/40 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New intent
          </button>
          {turns.length > 0 ? (
            <button
              type="button"
              onClick={onClear}
              title="Hides these on this device. Your record stays saved."
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {turns.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            Intents you compose are kept here, so you can reopen what the agents said. Start another
            with New intent — nothing you have already run is lost.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {turns.map((turn) => {
              const winnerName =
                turn.winner !== null ? turn.proposals[turn.winner]?.name : undefined
              return (
                <li key={turn.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(turn)}
                    className={cn(
                      'border-border hover:border-foreground/40 hover:bg-muted/40 w-full rounded-xl border p-3 text-left transition-colors'
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="line-clamp-2 text-sm">{turn.text}</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {when(turn.createdAt)}
                      </span>
                    </div>

                    <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {winnerName !== undefined ? <span>{winnerName} recommended</span> : null}
                      {turn.executedBy !== undefined ? (
                        <span className="text-foreground">
                          executed by {turn.proposals[turn.executedBy]?.name ?? turn.executedBy}
                        </span>
                      ) : null}
                      {/* A bundle is several transactions fulfilling one
                          instruction. Labelling it "swap" would describe only
                          its first part, so it is named for what it is and
                          every step gets its own links. */}
                      {turn.bundle !== undefined && turn.bundle.length > 0 ? (
                        <span className="border-border rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                          Bundled · {turn.bundle.length} steps
                        </span>
                      ) : null}
                      {turn.bundle === undefined && turn.txHash !== undefined ? (
                        <a
                          href={`${stellarTestnet.blockExplorerUrl}/tx/${turn.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
                        >
                          view transaction
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>

                    {/* Each step, with a link to the transaction and, where the
                        step left something behind in another protocol, a link
                        to that too — an explorer proves a supply happened and
                        shows nothing about the position it created. */}
                    {turn.bundle !== undefined && turn.bundle.length > 0 ? (
                      <ol className="border-border text-muted-foreground mt-2 flex flex-col gap-1 border-l pl-3 text-xs">
                        {turn.bundle.map((step, i) => (
                          <li
                            key={`${step.hash ?? 'step'}-${i}`}
                            className="flex flex-wrap items-center gap-x-2"
                          >
                            <span>
                              {i + 1}. {step.label}
                            </span>
                            {step.explorerUrl !== undefined ? (
                              <a
                                href={step.explorerUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
                              >
                                transaction
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                            {step.positionUrl !== undefined ? (
                              <a
                                href={step.positionUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
                              >
                                on {step.venue ?? 'the protocol'}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
