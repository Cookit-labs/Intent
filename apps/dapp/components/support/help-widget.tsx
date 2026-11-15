'use client'

import { cn } from '@intent/ui'
import { ArrowLeft, ArrowUp, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { walletFetch } from '../../lib/api/network-fetch'
import { useChain } from '../../providers/chain-provider'
import { agentBubble, systemPill, userBubble } from '../intents/bubble'

/**
 * The help button and its panel, at the bottom right of every chain page.
 *
 * The assistant answers first, from the person's own orders. When it cannot settle something, or
 * the person asks, the conversation becomes a ticket the team answers here.
 */

type Kind = 'problem' | 'suggestion' | 'complaint'
type Status = 'open' | 'answered' | 'closed'

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

interface Draft {
  kind: Kind
  title: string
  summary: string
}

interface TicketMessage {
  author: 'user' | 'assistant' | 'admin'
  body: string
  createdAt: string
}

interface TicketView {
  id: string
  kind: Kind
  status: Status
  title: string
  unread: boolean
  updatedAt: string
  messages?: TicketMessage[]
}

type Note =
  | { kind: 'offer'; draft: Draft }
  | { kind: 'filed'; id: string }
  | { kind: 'error'; text: string }

type View = { name: 'chat' } | { name: 'tickets' } | { name: 'thread'; id: string }

const GREETING =
  'What can I help with? Ask about an order, how to do something, or leave a suggestion for the team.'

const STATUS_TEXT: Record<Status, string> = {
  open: 'With the team',
  answered: 'The team replied',
  closed: 'Closed',
}

const POLL_MS = 60_000

async function readJson<T>(res: Response): Promise<T & { message?: string }> {
  return (await res.json().catch(() => ({}))) as T & { message?: string }
}

function when(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function Composer({
  placeholder,
  busy,
  onSend,
}: {
  placeholder: string
  busy: boolean
  onSend: (text: string) => void
}): JSX.Element {
  const [text, setText] = useState('')
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const value = text.trim()
    if (value === '' || busy) return
    onSend(value)
    setText('')
  }
  return (
    <form onSubmit={submit} className="border-border flex items-end gap-2 border-t p-3">
      <label className="sr-only" htmlFor="help-composer">
        {placeholder}
      </label>
      <textarea
        id="help-composer"
        rows={1}
        value={text}
        maxLength={2000}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e)
        }}
        className="border-border bg-background focus-visible:ring-brand/40 max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border px-3.5 py-2.5 text-sm outline-none focus-visible:ring-2"
      />
      <button
        type="submit"
        disabled={busy || text.trim() === ''}
        aria-label="Send"
        className="bg-brand text-brand-foreground focus-visible:ring-brand/40 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 disabled:opacity-40"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
    </form>
  )
}

function Thread({ children }: { children: ReactNode }): JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  })
  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4" aria-live="polite">
      {children}
      <div ref={end} />
    </div>
  )
}

function Typing(): JSX.Element {
  return (
    <div className={cn(agentBubble, 'text-muted-foreground')} aria-label="The assistant is writing">
      Looking into it…
    </div>
  )
}

export function HelpWidget(): JSX.Element {
  const { slug } = useChain()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>({ name: 'chat' })
  const [turns, setTurns] = useState<Turn[]>([])
  const [note, setNote] = useState<Note | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [tickets, setTickets] = useState<TicketView[]>([])
  const [thread, setThread] = useState<TicketView | undefined>(undefined)

  const unread = tickets.filter((t) => t.unread).length

  const loadTickets = useCallback(async () => {
    const res = await walletFetch('/api/support/tickets').catch(() => undefined)
    if (res === undefined || !res.ok) return
    const body = await readJson<{ tickets?: TicketView[] }>(res)
    setTickets(body.tickets ?? [])
  }, [])

  useEffect(() => {
    void loadTickets()
    const id = setInterval(() => void loadTickets(), POLL_MS)
    return () => clearInterval(id)
  }, [loadTickets])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const fileTicket = useCallback(
    async (conversation: Turn[], draft: Draft) => {
      setBusy(true)
      try {
        const res = await walletFetch('/api/support/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turns: conversation, chain: slug, draft }),
        })
        const body = await readJson<{ ticket?: TicketView }>(res)
        if (!res.ok || body.ticket === undefined) {
          setNote({
            kind: 'error',
            text: body.message ?? 'The ticket could not be sent. Try again in a moment.',
          })
          return
        }
        setNote({ kind: 'filed', id: body.ticket.id })
        void loadTickets()
      } finally {
        setBusy(false)
      }
    },
    [slug, loadTickets]
  )

  const ask = useCallback(
    async (text: string) => {
      const conversation: Turn[] = [...turns, { role: 'user', text }]
      setTurns(conversation)
      setNote(undefined)
      setBusy(true)
      let filed = false
      try {
        const res = await walletFetch('/api/support/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turns: conversation, chain: slug }),
        })
        const body = await readJson<{
          reply?: string
          next?: 'none' | 'offer_ticket' | 'file_ticket'
          draft?: Draft
        }>(res)
        if (!res.ok || body.reply === undefined || body.draft === undefined) {
          // The assistant is down, so the team is the way forward.
          setNote({
            kind: 'offer',
            draft: { kind: 'problem', title: text.slice(0, 80), summary: text },
          })
          return
        }
        const answered: Turn[] = [...conversation, { role: 'assistant', text: body.reply }]
        setTurns(answered)
        if (body.next === 'file_ticket') {
          filed = true
          setBusy(false)
          await fileTicket(answered, body.draft)
        } else if (body.next === 'offer_ticket') {
          setNote({ kind: 'offer', draft: body.draft })
        }
      } finally {
        if (!filed) setBusy(false)
      }
    },
    [turns, slug, fileTicket]
  )

  const openThread = useCallback(async (id: string) => {
    setView({ name: 'thread', id })
    setThread(undefined)
    const res = await walletFetch(`/api/support/tickets/${id}`).catch(() => undefined)
    if (res === undefined || !res.ok) return
    const body = await readJson<{ ticket?: TicketView }>(res)
    setThread(body.ticket)
    setTickets((list) => list.map((t) => (t.id === id ? { ...t, unread: false } : t)))
  }, [])

  const reply = useCallback(
    async (text: string) => {
      if (thread === undefined) return
      setBusy(true)
      try {
        const res = await walletFetch(`/api/support/tickets/${thread.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        const body = await readJson<{ ticket?: TicketView }>(res)
        if (res.ok && body.ticket !== undefined) setThread(body.ticket)
      } finally {
        setBusy(false)
      }
    },
    [thread]
  )

  const startOver = (): void => {
    setTurns([])
    setNote(undefined)
    setView({ name: 'chat' })
  }

  const title =
    view.name === 'chat'
      ? 'Help'
      : view.name === 'tickets'
        ? 'Your tickets'
        : (thread?.title ?? 'Ticket')

  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-40 flex flex-col items-end gap-3 lg:bottom-6 lg:right-6">
      {open ? (
        <section
          role="dialog"
          aria-label="Help"
          className="bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border dark:text-foreground pointer-events-auto flex h-[min(560px,calc(100dvh-9rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)] dark:border-white/[0.06] dark:bg-[#0F0F0F]"
        >
          <header className="border-border flex items-center gap-2 border-b px-4 py-3">
            {view.name !== 'chat' ? (
              <button
                type="button"
                aria-label="Back"
                onClick={() =>
                  setView(view.name === 'thread' ? { name: 'tickets' } : { name: 'chat' })
                }
                className="text-muted-foreground hover:text-foreground -ml-1 rounded-full p-1"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : null}
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
            {view.name === 'chat' && tickets.length > 0 ? (
              <button
                type="button"
                onClick={() => setView({ name: 'tickets' })}
                className="text-brand text-sm underline-offset-2 hover:underline"
              >
                Your tickets{unread > 0 ? ` (${unread} new)` : ''}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close help"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground rounded-full p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {view.name === 'chat' ? (
            <>
              <Thread>
                <div className={agentBubble}>{GREETING}</div>
                {turns.map((t, i) => (
                  <div
                    key={i}
                    className={t.role === 'user' ? cn(userBubble, 'self-end') : agentBubble}
                  >
                    {t.text}
                  </div>
                ))}
                {busy ? <Typing /> : null}
                {note?.kind === 'offer' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void fileTicket(
                        turns.length > 0 ? turns : [{ role: 'user', text: note.draft.summary }],
                        note.draft
                      )
                    }
                    className="bg-brand text-brand-foreground focus-visible:ring-brand/40 self-start rounded-full px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
                  >
                    Send this to the team
                  </button>
                ) : null}
                {note?.kind === 'filed' ? (
                  <div className={systemPill}>
                    <span>
                      Sent to the team. Their reply will show up here, under{' '}
                      <button
                        type="button"
                        onClick={() => void openThread(note.id)}
                        className="text-brand underline-offset-2 hover:underline"
                      >
                        your tickets
                      </button>
                      .
                    </span>
                  </div>
                ) : null}
                {note?.kind === 'error' ? <div className={systemPill}>{note.text}</div> : null}
              </Thread>
              {note?.kind === 'filed' ? (
                <div className="border-border border-t p-3">
                  <button
                    type="button"
                    onClick={startOver}
                    className="border-border hover:bg-muted/60 w-full rounded-2xl border px-4 py-2.5 text-sm"
                  >
                    Ask something else
                  </button>
                </div>
              ) : (
                <Composer
                  placeholder="Describe what is going on"
                  busy={busy}
                  onSend={(t) => void ask(t)}
                />
              )}
            </>
          ) : null}

          {view.name === 'tickets' ? (
            <ul className="flex-1 divide-y overflow-y-auto">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => void openThread(t.id)}
                    className="hover:bg-muted/50 flex w-full flex-col gap-0.5 px-4 py-3 text-left"
                  >
                    <span className={cn('truncate text-sm', t.unread && 'font-semibold')}>
                      {t.title}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t.unread ? 'New reply from the team' : STATUS_TEXT[t.status]},{' '}
                      {when(t.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {view.name === 'thread' ? (
            <>
              <Thread>
                {thread === undefined ? (
                  <div className={systemPill}>Loading the conversation…</div>
                ) : (
                  thread.messages?.map((m, i) =>
                    m.author === 'user' ? (
                      <div key={i} className={cn(userBubble, 'self-end')}>
                        {m.body}
                      </div>
                    ) : (
                      <div key={i} className="flex flex-col gap-1">
                        <span className="text-muted-foreground px-1 text-xs">
                          {m.author === 'admin' ? 'Intent team' : 'Assistant'}
                        </span>
                        <div className={agentBubble}>{m.body}</div>
                      </div>
                    )
                  )
                )}
                {thread?.status === 'closed' ? (
                  <div className={systemPill}>
                    This ticket is closed. Ask in Help to start a new one.
                  </div>
                ) : null}
              </Thread>
              {thread !== undefined && thread.status !== 'closed' ? (
                <Composer
                  placeholder="Reply to the team"
                  busy={busy}
                  onSend={(t) => void reply(t)}
                />
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Help, ${unread} new ${unread === 1 ? 'reply' : 'replies'}` : 'Help'
        }
        className="bg-brand text-brand-foreground focus-visible:ring-brand/40 pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium shadow-[0_6px_20px_-6px_rgb(63_68_167/0.6)] focus-visible:outline-none focus-visible:ring-2"
      >
        {open ? 'Close' : 'Help'}
        {unread > 0 && !open ? (
          <span className="bg-brand-foreground text-brand flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold">
            {unread}
          </span>
        ) : null}
      </button>
    </div>
  )
}
