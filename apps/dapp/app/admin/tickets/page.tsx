'use client'

import { cn } from '@intent/ui'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { EmptyNote, PageTitle, Panel } from '../../../components/admin/parts'
import { useScope } from '../../../components/admin/scope'
import { agentBubble, userBubble } from '../../../components/intents/bubble'
import type {
  OrderSnapshot,
  Ticket,
  TicketKind,
  TicketStatus,
  TicketWithMessages,
} from '../../../lib/support/tickets'

const REFRESH_MS = 30_000

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Needs a reply',
  answered: 'Answered',
  closed: 'Closed',
}

const KIND_LABEL: Record<TicketKind, string> = {
  problem: 'Problem',
  suggestion: 'Suggestion',
  complaint: 'Complaint',
}

const STATUS_FILTERS: { value: TicketStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Needs a reply' },
  { value: 'answered', label: 'Answered' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

const KIND_FILTERS: { value: TicketKind | 'all'; label: string }[] = [
  { value: 'all', label: 'Every kind' },
  { value: 'problem', label: 'Problems' },
  { value: 'suggestion', label: 'Suggestions' },
  { value: 'complaint', label: 'Complaints' },
]

const ORDER_STATUS: Record<string, string> = {
  waiting: 'Waiting for deposit',
  processing: 'Paying out',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
  refunded: 'Refunded',
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function who(ticket: Ticket): string {
  const key = ticket.wallet ?? ticket.requester.replace(/^wallet:/, '')
  return key.length > 16 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="bg-muted/60 flex w-fit flex-wrap rounded-lg p-1"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors',
            value === o.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Orders({ title, orders }: { title: string; orders: OrderSnapshot[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {orders.length === 0 ? (
        <p className="text-muted-foreground text-sm">No off-ramp orders.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-normal">Order</th>
                <th className="py-1.5 pr-3 font-normal">Status</th>
                <th className="py-1.5 pr-3 font-normal">Provider says</th>
                <th className="py-1.5 pr-3 text-right font-normal">Sent</th>
                <th className="py-1.5 pr-3 text-right font-normal">Payout</th>
                <th className="py-1.5 font-normal">Made</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-border border-t">
                  <td className="py-1.5 pr-3 font-mono text-xs">
                    {o.id.slice(0, 8)}
                    <span className="text-muted-foreground block font-sans">
                      {o.chain}, {o.provider}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {ORDER_STATUS[o.status] ?? o.status}
                    <span className="text-muted-foreground block text-xs">
                      {o.depositSent ? 'Deposit sent' : 'No deposit'}
                    </span>
                  </td>
                  <td className="text-muted-foreground py-1.5 pr-3 text-xs">{o.providerStatus}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {o.amount} {o.coin}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {Number(o.payout).toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                    {o.currency}
                  </td>
                  <td className="text-muted-foreground py-1.5 text-xs">{ago(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }): JSX.Element {
  const [ticket, setTicket] = useState<TicketWithMessages | null>(null)
  const [current, setCurrent] = useState<OrderSnapshot[]>([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/tickets/${id}`)
    const body = (await res.json().catch(() => ({}))) as {
      ticket?: TicketWithMessages
      current?: OrderSnapshot[]
    }
    if (!res.ok || body.ticket === undefined) {
      setError('This ticket could not be loaded.')
      return
    }
    setTicket(body.ticket)
    setCurrent(body.current ?? [])
  }, [id])

  useEffect(() => {
    setTicket(null)
    setError(undefined)
    void load()
  }, [load])

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (reply.trim() === '' || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/tickets/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: reply.trim() }),
      })
      if (!res.ok) {
        setError('The reply was not sent. Try again.')
        return
      }
      setReply('')
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status: TicketStatus): Promise<void> => {
    setBusy(true)
    try {
      await fetch(`/api/admin/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (error !== undefined && ticket === null) {
    return <p className="text-muted-foreground text-sm">{error}</p>
  }
  if (ticket === null) {
    return <div aria-busy="true" className="bg-muted/40 h-64 animate-pulse rounded-2xl" />
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-medium">{ticket.title}</h2>
          <p className="text-muted-foreground text-sm">
            {KIND_LABEL[ticket.kind]} from <span className="font-mono text-xs">{who(ticket)}</span>{' '}
            on {ticket.chain ?? 'an unknown chain'}, filed {ago(ticket.createdAt)}.{' '}
            {STATUS_LABEL[ticket.status]}.
          </p>
        </div>
        {ticket.status === 'closed' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setStatus('open')}
            className="border-border hover:bg-muted/60 rounded-md border px-3 py-1.5 text-sm"
          >
            Reopen
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setStatus('closed')}
            className="border-border hover:bg-muted/60 rounded-md border px-3 py-1.5 text-sm"
          >
            Close ticket
          </button>
        )}
      </div>

      <p className="bg-muted/50 rounded-xl px-4 py-3 text-sm leading-relaxed">{ticket.summary}</p>

      <div className="flex flex-col gap-2.5">
        {ticket.messages.map((m, i) =>
          m.author === 'user' ? (
            <div key={i} className="flex flex-col items-start gap-1">
              <span className="text-muted-foreground px-1 text-xs">Person, {ago(m.createdAt)}</span>
              <div className={cn(userBubble, 'rounded-bl-md rounded-br-[22px]')}>{m.body}</div>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-end gap-1">
              <span className="text-muted-foreground px-1 text-xs">
                {m.author === 'admin' ? 'You' : 'Assistant'}, {ago(m.createdAt)}
              </span>
              <div
                className={cn(
                  agentBubble,
                  'rounded-bl-[22px] rounded-br-md',
                  m.author === 'admin' && 'border-brand/40'
                )}
              >
                {m.body}
              </div>
            </div>
          )
        )}
      </div>

      {ticket.status !== 'closed' ? (
        <form onSubmit={(e) => void send(e)} className="flex flex-col gap-2">
          <label htmlFor="ticket-reply" className="text-sm font-medium">
            Reply
          </label>
          <textarea
            id="ticket-reply"
            rows={3}
            value={reply}
            maxLength={2000}
            onChange={(e) => setReply(e.target.value)}
            placeholder="The person sees this in the help panel, and by email if they gave one."
            className="border-border bg-background focus-visible:ring-brand/40 rounded-xl border px-3.5 py-2.5 text-sm outline-none focus-visible:ring-2"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">{error}</span>
            <button
              type="submit"
              disabled={busy || reply.trim() === ''}
              className="bg-brand text-brand-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Send reply
            </button>
          </div>
        </form>
      ) : null}

      <Orders title="Their orders now" orders={current} />
      <Orders title="Their orders when they filed" orders={ticket.context} />
    </div>
  )
}

export default function AdminTicketsPage(): JSX.Element {
  const { scope } = useScope()
  const [status, setStatus] = useState<TicketStatus | 'all'>('open')
  const [kind, setKind] = useState<TicketKind | 'all'>('all')
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [openCount, setOpenCount] = useState(0)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams()
    if (status !== 'all') query.set('status', status)
    if (kind !== 'all') query.set('kind', kind)
    if (scope.chain !== 'all') query.set('chain', scope.chain)
    fetch(`/api/admin/tickets?${query.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          tickets?: Ticket[]
          openCount?: number
          error?: string
        }
        if (!res.ok || body.tickets === undefined) throw new Error(body.error ?? 'unavailable')
        setTickets(body.tickets)
        setOpenCount(body.openCount ?? 0)
        setError(undefined)
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(
          e instanceof Error && e.message === 'no_database'
            ? 'No database is connected, so there are no tickets yet.'
            : 'The tickets could not be loaded. Try again in a moment.'
        )
      })
    return () => controller.abort()
  }, [status, kind, scope.chain, tick])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (selected === undefined && tickets !== null && tickets.length > 0)
      setSelected(tickets[0]!.id)
  }, [tickets, selected])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  return (
    <>
      <PageTitle
        title="Tickets"
        hint={`Problems, suggestions and complaints from the help button. ${openCount} need${openCount === 1 ? 's' : ''} a reply.`}
      />

      <div className="flex flex-wrap gap-3">
        <Segmented label="Status" options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <Segmented label="Kind" options={KIND_FILTERS} value={kind} onChange={setKind} />
      </div>

      {error !== undefined ? (
        <Panel title="Could not load the tickets">
          <p className="text-muted-foreground text-sm">{error}</p>
        </Panel>
      ) : tickets === null ? (
        <div aria-busy="true" className="bg-muted/40 h-64 animate-pulse rounded-2xl" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
          <Panel title={`${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`}>
            {tickets.length === 0 ? (
              <EmptyNote>Nothing here. New tickets show up as people file them.</EmptyNote>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(t.id)}
                      aria-current={selected === t.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-lg px-2 py-2.5 text-left transition-colors',
                        selected === t.id ? 'bg-muted' : 'hover:bg-muted/60'
                      )}
                    >
                      <span className="truncate text-sm font-medium">{t.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {KIND_LABEL[t.kind]} on {t.chain ?? 'unknown chain'}, {ago(t.updatedAt)}
                      </span>
                      {t.status === 'open' ? (
                        <span className="text-brand text-xs">Needs a reply</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Conversation">
            {selected === undefined ? (
              <EmptyNote>Pick a ticket to read it.</EmptyNote>
            ) : (
              <Detail key={selected} id={selected} onChanged={refresh} />
            )}
          </Panel>
        </div>
      )}
    </>
  )
}
