'use client'

import { cn } from '@intent/ui'
import { motion } from 'framer-motion'
import {
  ArrowLeftRight,
  Banknote,
  Check,
  ExternalLink,
  Layers,
  MessageCircle,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { stellarNetwork } from '@intent/config'
import type { ChatTurn } from '../../lib/chat-history'
import { AgentAvatar } from '../agents/agent-avatar'

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
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Which heading a turn sits under, by calendar day rather than elapsed hours. */
function dayGroup(iso: string): string {
  const day = new Date(iso)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const diffDays = Math.floor((start.getTime() - day.getTime()) / 86_400_000) + 1
  if (day.getTime() >= start.getTime()) return 'Today'
  if (diffDays <= 1) return 'Yesterday'
  if (diffDays <= 7) return 'This week'
  return 'Earlier'
}

type Status = 'done' | 'open' | 'none'

function statusOf(turn: ChatTurn): Status {
  if (turn.txHash !== undefined || (turn.bundle ?? []).some((s) => s.hash !== undefined)) {
    return 'done'
  }
  // Something was asked to happen and did not: a race ran, or a cash-out was set up.
  if (Object.keys(turn.proposals).length > 0 || /cash|off-?ramp|payout/i.test(turn.text)) {
    return 'open'
  }
  return 'none'
}

/** The line under the intent: what was said back, in the fewest words. */
function preview(turn: ChatTurn): string {
  if (turn.outcome !== undefined) return turn.outcome
  const chosen = turn.executedBy ?? turn.winner
  const proposal = chosen !== null ? turn.proposals[chosen] : undefined
  if (proposal?.reasoning !== undefined && proposal.reasoning !== '') {
    return `${proposal.name}: ${proposal.reasoning}`
  }
  const lastReply = [...(turn.conversation ?? [])].reverse().find((t) => t.role === 'assistant')
  if (lastReply !== undefined) return lastReply.content
  return statusOf(turn) === 'done' ? 'Completed on-chain' : 'No reply was recorded'
}

function Leading({ turn }: { turn: ChatTurn }): JSX.Element {
  const agentKey = turn.executedBy ?? turn.winner
  const agent = agentKey !== null ? turn.proposals[agentKey] : undefined
  const status = statusOf(turn)
  const Icon =
    turn.bundle !== undefined && turn.bundle.length > 0
      ? Layers
      : /cash|off-?ramp|payout|naira/i.test(turn.text)
        ? Banknote
        : /swap|buy|sell|convert/i.test(turn.text)
          ? ArrowLeftRight
          : MessageCircle

  return (
    <span className="relative shrink-0">
      {agent !== undefined ? (
        <AgentAvatar seed={agent.key} name={agent.name} className="h-11 w-11" />
      ) : (
        <span className="bg-bubble-me text-bubble-me-foreground flex h-11 w-11 items-center justify-center rounded-full">
          <Icon className="h-5 w-5" />
        </span>
      )}
      {status === 'done' ? (
        <span className="bg-success border-card absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 text-white">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </span>
  )
}

const FILTERS = [
  ['all', 'All'],
  ['done', 'Done'],
  ['open', 'Not executed'],
] as const

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
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = turns.filter((t) => {
      if (filter !== 'all' && statusOf(t) !== filter) return false
      return q === '' || t.text.toLowerCase().includes(q) || preview(t).toLowerCase().includes(q)
    })
    const out: { label: string; turns: ChatTurn[] }[] = []
    for (const turn of shown) {
      const label = dayGroup(turn.createdAt)
      const last = out.at(-1)
      if (last?.label === label) last.turns.push(turn)
      else out.push({ label, turns: [turn] })
    }
    return out
  }, [turns, query, filter])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="bg-card absolute inset-0 z-20 flex flex-col"
    >
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold">Past intents</span>
            {turns.length > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">{turns.length}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onNew}
              className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New intent
            </button>
            {turns.length > 0 ? (
              <button
                type="button"
                onClick={onClear}
                title="Hides these on this device. Your record stays saved."
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-full px-3 py-1.5 text-xs transition-colors"
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close history"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-full p-1.5 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {turns.length > 0 ? (
          <>
            <label className="bg-muted/60 focus-within:bg-background focus-within:border-brand/40 flex items-center gap-2 rounded-full border border-transparent px-3 py-2 transition-colors">
              <Search className="text-muted-foreground h-4 w-4" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search intents"
                aria-label="Search intents"
                className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
              />
              {query !== '' ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </label>
            <div className="flex gap-1.5">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    filter === value
                      ? 'bg-foreground text-background'
                      : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="scrollbar-none flex-1 overflow-y-auto px-2 pb-3">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="bg-bubble-me text-bubble-me-foreground flex h-14 w-14 items-center justify-center rounded-full">
              <MessageCircle className="h-6 w-6" />
            </span>
            <p className="text-sm font-medium">No intents yet</p>
            <p className="text-muted-foreground max-w-xs text-xs">
              Every intent you compose is kept here, with what the agents said, so you can reopen it
              later.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="text-muted-foreground p-8 text-center text-sm">
            Nothing matches{query !== '' ? ` “${query}”` : ''}.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-2">
              <h3 className="text-muted-foreground bg-card sticky top-0 z-10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider">
                {group.label}
              </h3>
              <ul className="flex flex-col">
                {group.turns.map((turn) => {
                  const status = statusOf(turn)
                  const bundle = turn.bundle ?? []
                  return (
                    <li key={turn.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelect(turn)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onSelect(turn)
                          }
                        }}
                        className="hover:bg-muted/50 focus-visible:bg-muted/50 group flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none transition-colors"
                      >
                        <Leading turn={turn} />

                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-sm font-medium">{turn.text}</span>
                            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                              {when(turn.createdAt)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                              {preview(turn)}
                            </span>
                            {/* A bundle is several transactions fulfilling one
                                instruction. Labelling it "swap" would describe
                                only its first part. */}
                            {bundle.length > 0 ? (
                              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
                                {bundle.length} steps
                              </span>
                            ) : status === 'done' ? (
                              <span className="bg-success/15 text-success shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
                                Done
                              </span>
                            ) : status === 'open' ? (
                              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
                                Not executed
                              </span>
                            ) : null}
                            {bundle.length === 0 && turn.txHash !== undefined ? (
                              <a
                                href={`${stellarNetwork.blockExplorerUrl}/tx/${turn.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="View transaction"
                                title="View transaction"
                                className="text-muted-foreground hover:text-foreground hover:bg-background shrink-0 rounded-full p-1 transition-colors"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>

                          {/* Each step, with a link to the transaction and, where
                              the step left something behind in another protocol,
                              a link to that too — an explorer proves a supply
                              happened and shows nothing about the position. */}
                          {bundle.length > 0 ? (
                            <ol className="mt-2 flex flex-wrap gap-1.5">
                              {bundle.map((step, i) => (
                                <li
                                  key={`${step.hash ?? 'step'}-${i}`}
                                  className="bg-muted/70 text-muted-foreground flex items-center gap-1.5 rounded-full py-0.5 pl-2 pr-1 text-[11px]"
                                >
                                  <span className="text-foreground font-medium">{i + 1}</span>
                                  <span className="max-w-[160px] truncate">{step.label}</span>
                                  {step.explorerUrl !== undefined ? (
                                    <a
                                      href={step.explorerUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      aria-label={`Transaction for step ${i + 1}`}
                                      className="hover:text-foreground rounded-full p-0.5"
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  ) : null}
                                  {step.positionUrl !== undefined ? (
                                    <a
                                      href={step.positionUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="hover:text-foreground underline underline-offset-2"
                                    >
                                      {step.venue ?? 'protocol'}
                                    </a>
                                  ) : null}
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </motion.div>
  )
}
