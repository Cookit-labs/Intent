'use client'

import { cn } from '@intent/ui'
import { ArrowLeft, ArrowUp, MessageCircleQuestion, MoreHorizontal, X } from 'lucide-react'
import Image from 'next/image'
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

const GREETING = 'Ask about an order, get unstuck, or share an idea with the team.'

const STATUS_TEXT: Record<Status, string> = {
  open: 'With the team',
  answered: 'The team replied',
  closed: 'Closed',
}

const POLL_MS = 60_000

/** Set once the person has seen the note about the help button, so it shows only once. */
const INTRO_KEY = 'intent:help-intro-seen'
const INTRO_DELAY_MS = 1500

function introSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) === '1'
  } catch {
    return true
  }
}

function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_KEY, '1')
  } catch {
    // Storage is blocked; the note may show again on the next visit.
  }
}

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
  const empty = text.trim() === ''
  return (
    <form onSubmit={submit} className="p-3">
      <div className="border-border bg-background focus-within:border-brand focus-within:ring-brand/15 rounded-2xl border px-3.5 pb-2.5 pt-3 transition-shadow focus-within:ring-4">
        <label className="sr-only" htmlFor="help-composer">
          {placeholder}
        </label>
        <textarea
          id="help-composer"
          rows={2}
          value={text}
          maxLength={2000}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e)
          }}
          className="placeholder:text-muted-foreground max-h-32 w-full resize-none bg-transparent text-sm outline-none"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-muted-foreground hidden text-xs sm:inline">
            Shift + Enter for a new line
          </span>
          <button
            type="submit"
            disabled={busy || empty}
            aria-label="Send"
            className={cn(
              'focus-visible:ring-brand/40 ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2',
              busy || empty ? 'bg-muted text-muted-foreground' : 'bg-brand text-brand-foreground'
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </form>
  )
}

function Avatar(): JSX.Element {
  return (
    <span className="bg-brand flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
      <Image
        src="/images/intent-logo.png"
        alt=""
        width={512}
        height={361}
        className="h-3.5 w-auto invert"
      />
    </span>
  )
}

const QUICK_STARTS = [
  'My off-ramp is stuck',
  'Something is not working',
  'I have an idea for Intent',
]

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
  const [intro, setIntro] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
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
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menu])

  // A short note beside the button the first time someone lands with a wallet connected.
  // It waits for any other notice on screen, such as a chain's beta notice, to be closed first.
  useEffect(() => {
    if (introSeen()) return
    const id = setInterval(() => {
      if (document.querySelector('[aria-modal="true"]') !== null) return
      clearInterval(id)
      setIntro(true)
    }, INTRO_DELAY_MS)
    return () => clearInterval(id)
  }, [])

  const dismissIntro = useCallback(() => {
    setIntro(false)
    markIntroSeen()
  }, [])

  useEffect(() => {
    if (!intro) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissIntro()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [intro, dismissIntro])

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

  const heading =
    view.name === 'chat'
      ? { name: 'Intent', status: 'The assistant answers right away' }
      : view.name === 'tickets'
        ? {
            name: 'Your tickets',
            status: `${tickets.length} conversation${tickets.length === 1 ? '' : 's'} with the team`,
          }
        : {
            name: thread?.title ?? 'Ticket',
            status: thread !== undefined ? STATUS_TEXT[thread.status] : 'Loading',
          }

  const spotlight = intro && !open

  return (
    <>
      {spotlight ? (
        // Dims the page so the help button is the one bright thing on it. A click anywhere closes it.
        <div
          aria-hidden="true"
          onClick={dismissIntro}
          className="animate-in fade-in fixed inset-0 z-[45] bg-black/55 duration-300 motion-reduce:animate-none"
        />
      ) : null}
      <div
        className={cn(
          'pointer-events-none fixed bottom-24 right-4 flex flex-col items-end gap-3 lg:bottom-6 lg:right-6',
          spotlight ? 'z-50' : 'z-40'
        )}
      >
        {open ? (
          <section
            role="dialog"
            aria-label="Help"
            className="bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border dark:text-foreground pointer-events-auto flex h-[min(640px,calc(100dvh-8rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)] dark:border-white/[0.06] dark:bg-[#0F0F0F]"
          >
            <header className="border-border flex items-center gap-2.5 border-b px-3 py-3">
              {view.name !== 'chat' ? (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() =>
                    setView(view.name === 'thread' ? { name: 'tickets' } : { name: 'chat' })
                  }
                  className="text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-full p-1.5"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              ) : null}
              <Avatar />
              <div className="flex min-w-0 flex-1 flex-col">
                <h2 className="truncate text-sm font-semibold">{heading.name}</h2>
                <p className="text-muted-foreground truncate text-xs">{heading.status}</p>
              </div>
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  aria-label={unread > 0 ? `More, ${unread} new` : 'More'}
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  onClick={() => setMenu((v) => !v)}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted/60 relative rounded-full p-1.5"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  {unread > 0 ? (
                    <span className="bg-brand text-brand-foreground ring-bubble-agent absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold ring-2 dark:ring-[#0F0F0F]">
                      {unread}
                    </span>
                  ) : null}
                </button>
                {menu ? (
                  <div
                    role="menu"
                    className="border-border bg-background absolute right-0 z-10 mt-1.5 w-48 rounded-xl border p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false)
                        startOver()
                      }}
                      className="hover:bg-muted/60 w-full rounded-lg px-3 py-2 text-left text-sm"
                    >
                      New conversation
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false)
                        setView({ name: 'tickets' })
                      }}
                      className="hover:bg-muted/60 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm"
                    >
                      Your tickets
                      {unread > 0 ? (
                        <span className="text-brand text-xs font-medium">{unread} new</span>
                      ) : null}
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Close help"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-full p-1.5"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {view.name === 'chat' ? (
              <>
                <Thread>
                  {turns.length === 0 && note === undefined ? (
                    <div className="flex flex-1 flex-col items-center justify-between gap-6 pt-2">
                      <p className="text-muted-foreground max-w-[30ch] text-center text-sm">
                        {GREETING}
                      </p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {QUICK_STARTS.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={() => void ask(q)}
                            className="bg-brand/10 text-brand hover:bg-brand/15 dark:bg-brand/30 dark:hover:bg-brand/40 rounded-full px-3 py-1.5 text-sm transition-colors dark:text-white/90"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
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
                  <Composer placeholder="Message…" busy={busy} onSend={(t) => void ask(t)} />
                )}
              </>
            ) : null}

            {view.name === 'tickets' ? (
              <ul className="flex-1 divide-y overflow-y-auto">
                {tickets.length === 0 ? (
                  <li className="text-muted-foreground px-6 py-10 text-center text-sm">
                    No tickets yet. Anything you send to the team shows up here.
                  </li>
                ) : null}
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
                    placeholder="Reply to the team…"
                    busy={busy}
                    onSend={(t) => void reply(t)}
                  />
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {intro && !open ? (
          <section
            aria-label="Help is here"
            className="bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border dark:text-foreground animate-in fade-in slide-in-from-bottom-2 pointer-events-auto relative w-[min(300px,calc(100vw-2rem))] rounded-2xl border p-4 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)] duration-300 motion-reduce:animate-none dark:border-white/[0.06] dark:bg-[#0F0F0F]"
          >
            <p className="text-sm font-semibold">Help, tickets and suggestions are here</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              Stuck on an order or something not working? Ask here and the assistant helps right
              away. Anything it can&apos;t fix goes to the team as a ticket, and ideas for Intent
              are welcome too.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  dismissIntro()
                  setOpen(true)
                }}
                className="bg-brand text-brand-foreground focus-visible:ring-brand/40 rounded-full px-3.5 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2"
              >
                Open help
              </button>
              <button
                type="button"
                onClick={dismissIntro}
                className="text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 text-sm"
              >
                Got it
              </button>
            </div>
            <span
              aria-hidden="true"
              className="bg-bubble-agent border-bubble-agent-border absolute -bottom-[7px] right-5 h-3 w-3 rotate-45 border-b border-r dark:border-white/[0.06] dark:bg-[#0F0F0F]"
            />
          </section>
        ) : null}

        <button
          type="button"
          onClick={() => {
            if (intro) dismissIntro()
            setOpen((v) => !v)
          }}
          aria-expanded={open}
          aria-label={
            open
              ? 'Close help'
              : unread > 0
                ? `Help, ${unread} new ${unread === 1 ? 'reply' : 'replies'}`
                : 'Help'
          }
          title="Help"
          className={cn(
            'bg-brand text-brand-foreground focus-visible:ring-brand/40 pointer-events-auto relative flex h-12 w-12 items-center justify-center rounded-full shadow-[0_6px_20px_-6px_rgb(63_68_167/0.6)] transition-shadow focus-visible:outline-none focus-visible:ring-2',
            spotlight &&
              'shadow-[0_0_0_6px_rgb(255_255_255/0.9),0_0_0_14px_rgb(99_104_210/0.45),0_0_40px_12px_rgb(99_104_210/0.5)]'
          )}
        >
          {open ? <X className="h-5 w-5" /> : <MessageCircleQuestion className="h-6 w-6" />}
          {unread > 0 && !open ? (
            <span className="bg-background text-brand ring-brand absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold ring-2">
              {unread}
            </span>
          ) : null}
        </button>
      </div>
    </>
  )
}
