import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSupportRepo, type SupportRepo } from '../support/tickets'
import { fakeSupportDb } from './fakes/support-db'

let repo: SupportRepo
const askAssistant = vi.fn()
const notifyTeam = vi.fn(async () => undefined)
const notifyPerson = vi.fn(async () => undefined)
const SERVER_ORDERS = [
  {
    id: 'w1',
    kind: 'offramp',
    chain: 'stellar',
    provider: 'linq',
    status: 'processing',
    providerStatus: 'processing: in bank queue',
    amount: '20',
    coin: 'USDC',
    payout: '28046',
    currency: 'NGN',
    depositSent: true,
    createdAt: '2026-11-15T10:00:00.000Z',
  },
]

vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../support/tickets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/tickets')>()),
  getSupportRepo: async () => repo,
}))
vi.mock('../support/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/context')>()),
  recentOrders: async () => SERVER_ORDERS,
}))
vi.mock('../support/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/assistant')>()),
  askAssistant: (...a: unknown[]) => askAssistant(...a),
}))
vi.mock('../support/notify', () => ({
  notifyTeam: (...a: unknown[]) => notifyTeam(...(a as [])),
  notifyPerson: (...a: unknown[]) => notifyPerson(...(a as [])),
}))

import * as adminTicket from '../../app/api/admin/tickets/[id]/route'
import * as adminTickets from '../../app/api/admin/tickets/route'
import * as chat from '../../app/api/support/chat/route'
import * as personTicket from '../../app/api/support/tickets/[id]/route'
import * as personTickets from '../../app/api/support/tickets/route'

const ALICE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'
const BOB = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'
const ADMIN = 'an-admin-token-of-length'

function req(
  path: string,
  init: { method?: string; wallet?: string; admin?: boolean; body?: unknown } = {}
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.wallet !== undefined) headers['x-intent-wallet'] = init.wallet
  if (init.admin === true) headers['x-admin-token'] = ADMIN
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const NEW_TICKET = {
  chain: 'stellar',
  turns: [
    { role: 'user', text: 'my off-ramp is stuck' },
    { role: 'assistant', text: 'It is paying out. Want me to send it to the team?' },
    { role: 'user', text: 'yes please' },
  ],
  draft: { kind: 'problem', title: 'Off-ramp not received', summary: 'Order w1, 20 USDC.' },
}

async function fileTicket(wallet = ALICE): Promise<string> {
  const res = await personTickets.POST(
    req('/api/support/tickets', { method: 'POST', wallet, body: NEW_TICKET })
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { ticket: { id: string } }).ticket.id
}

beforeEach(() => {
  let n = 0
  repo = createSupportRepo(fakeSupportDb().query, () => `t${++n}`)
  vi.stubEnv('DATABASE_URL', 'postgres://fake')
  vi.stubEnv('ADMIN_TOKEN', ADMIN)
  askAssistant.mockReset()
  notifyTeam.mockClear()
  notifyPerson.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/support/chat', () => {
  it('helps without a wallet, telling the model no orders can be looked up', async () => {
    askAssistant.mockResolvedValue({
      ok: true,
      reply: 'Connect your wallet from the top right.',
      next: 'none',
      draft: { kind: 'problem', title: 'Wallet', summary: '' },
    })
    const res = await chat.POST(
      req('/api/support/chat', {
        method: 'POST',
        body: { turns: [{ role: 'user', text: 'how do I connect' }] },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ next: 'none' })
    expect(askAssistant.mock.calls[0]![0]).toMatchObject({
      orders: expect.stringContaining('has not connected a wallet'),
    })
  })

  it('gives the model the orders the server looked up for this wallet', async () => {
    askAssistant.mockResolvedValue({
      ok: true,
      reply: 'ok',
      next: 'none',
      draft: { kind: 'problem', title: 't', summary: '' },
    })
    await chat.POST(
      req('/api/support/chat', {
        method: 'POST',
        wallet: ALICE,
        body: { turns: [{ role: 'user', text: 'stuck' }], chain: 'stellar' },
      })
    )
    expect(askAssistant.mock.calls[0]![0]).toMatchObject({
      orders: expect.stringContaining('order w1'),
      chain: 'stellar',
    })
  })

  it('refuses an empty conversation, and says so when the assistant is down', async () => {
    expect(
      (await chat.POST(req('/api/support/chat', { method: 'POST', body: { turns: [] } }))).status
    ).toBe(400)
    askAssistant.mockResolvedValue({ ok: false, error: 'unavailable' })
    const res = await chat.POST(
      req('/api/support/chat', { method: 'POST', body: { turns: [{ role: 'user', text: 'hi' }] } })
    )
    expect(res.status).toBe(502)
    expect(((await res.json()) as { message: string }).message).toContain('send this to the team')
  })
})

describe('the person’s tickets', () => {
  it('needs a wallet to file, so the team can reply', async () => {
    const res = await personTickets.POST(
      req('/api/support/tickets', { method: 'POST', body: NEW_TICKET })
    )
    expect(res.status).toBe(401)
  })

  it('files with the orders the server looked up, the conversation, and tells the team', async () => {
    const id = await fileTicket()
    const ticket = await repo.get(id)
    expect(ticket?.requester).toBe(`wallet:${ALICE}`)
    expect(ticket?.wallet).toBe(ALICE)
    expect(ticket?.context.map((o) => o.id)).toEqual(['w1'])
    expect(ticket?.messages).toHaveLength(3)
    expect(notifyTeam).toHaveBeenCalledWith(expect.objectContaining({ id }), 'new')
  })

  it("does not show one wallet's ticket to another", async () => {
    const id = await fileTicket(ALICE)
    expect(
      (await personTicket.GET(req(`/api/support/tickets/${id}`, { wallet: BOB }), params(id)))
        .status
    ).toBe(404)
    const reply = await personTicket.POST(
      req(`/api/support/tickets/${id}`, {
        method: 'POST',
        wallet: BOB,
        body: { text: 'mine now' },
      }),
      params(id)
    )
    expect(reply.status).toBe(404)
    const list = (await (
      await personTickets.GET(req('/api/support/tickets', { wallet: BOB }))
    ).json()) as {
      tickets: unknown[]
    }
    expect(list.tickets).toEqual([])
  })

  it('shows the person no order data or requester key', async () => {
    const id = await fileTicket()
    const body = (await (
      await personTicket.GET(req(`/api/support/tickets/${id}`, { wallet: ALICE }), params(id))
    ).json()) as { ticket: Record<string, unknown> }
    expect(body.ticket).not.toHaveProperty('context')
    expect(body.ticket).not.toHaveProperty('requester')
  })
})

describe('the admin side', () => {
  it('is closed to anyone without the admin session', async () => {
    const id = await fileTicket()
    expect((await adminTickets.GET(req('/api/admin/tickets'))).status).toBe(401)
    expect((await adminTicket.GET(req(`/api/admin/tickets/${id}`), params(id))).status).toBe(401)
    expect(
      (
        await adminTicket.POST(
          req(`/api/admin/tickets/${id}`, { method: 'POST', wallet: ALICE, body: { text: 'x' } }),
          params(id)
        )
      ).status
    ).toBe(401)
  })

  it('lists tickets with the open count, and shows the orders as they stand now', async () => {
    const id = await fileTicket()
    const list = (await (
      await adminTickets.GET(req('/api/admin/tickets', { admin: true }))
    ).json()) as {
      tickets: { id: string }[]
      openCount: number
    }
    expect(list.tickets.map((t) => t.id)).toEqual([id])
    expect(list.openCount).toBe(1)

    const detail = (await (
      await adminTicket.GET(req(`/api/admin/tickets/${id}`, { admin: true }), params(id))
    ).json()) as { current: { id: string }[] }
    expect(detail.current.map((o) => o.id)).toEqual(['w1'])
  })

  it('a reply reaches the person as unread, reading clears it, and their answer reopens it', async () => {
    const id = await fileTicket()
    const replied = await adminTicket.POST(
      req(`/api/admin/tickets/${id}`, {
        method: 'POST',
        admin: true,
        body: { text: 'Paid at 10:04, check your bank.' },
      }),
      params(id)
    )
    expect(replied.status).toBe(200)
    expect(notifyPerson).toHaveBeenCalledOnce()

    const mine = (await (
      await personTickets.GET(req('/api/support/tickets', { wallet: ALICE }))
    ).json()) as {
      tickets: { unread: boolean; status: string }[]
    }
    expect(mine.tickets[0]).toMatchObject({ unread: true, status: 'answered' })

    const opened = (await (
      await personTicket.GET(req(`/api/support/tickets/${id}`, { wallet: ALICE }), params(id))
    ).json()) as { ticket: { unread: boolean; messages: { author: string }[] } }
    expect(opened.ticket.unread).toBe(false)
    expect(opened.ticket.messages.at(-1)?.author).toBe('admin')

    await personTicket.POST(
      req(`/api/support/tickets/${id}`, {
        method: 'POST',
        wallet: ALICE,
        body: { text: 'Got it, thanks' },
      }),
      params(id)
    )
    expect((await repo.get(id))?.status).toBe('open')
    expect(notifyTeam).toHaveBeenLastCalledWith(expect.objectContaining({ id }), 'reply')
  })

  it('closes a ticket, and refuses a status it does not know', async () => {
    const id = await fileTicket()
    const closed = await adminTicket.PATCH(
      req(`/api/admin/tickets/${id}`, { method: 'PATCH', admin: true, body: { status: 'closed' } }),
      params(id)
    )
    expect(closed.status).toBe(200)
    expect((await repo.get(id))?.status).toBe('closed')
    const bad = await adminTicket.PATCH(
      req(`/api/admin/tickets/${id}`, {
        method: 'PATCH',
        admin: true,
        body: { status: 'deleted' },
      }),
      params(id)
    )
    expect(bad.status).toBe(400)
  })
})
