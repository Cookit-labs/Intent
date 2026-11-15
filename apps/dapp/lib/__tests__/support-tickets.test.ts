import { describe, expect, it } from 'vitest'

import { createSupportRepo, type NewTicket } from '../support/tickets'
import { fakeSupportDb } from './fakes/support-db'

function repoWithIds() {
  const db = fakeSupportDb()
  let n = 0
  return { db, repo: createSupportRepo(db.query, () => `t${++n}`) }
}

const ALICE = 'wallet:GALICE'
const BOB = 'wallet:GBOB'

function ticketFor(requester: string, overrides: Partial<NewTicket> = {}): NewTicket {
  return {
    requester,
    wallet: requester.replace('wallet:', ''),
    chain: 'stellar',
    kind: 'problem',
    title: 'Off-ramp stuck',
    summary: 'Sent 20 USDC, no naira yet.',
    context: [],
    messages: [
      { author: 'user', body: 'my off-ramp is stuck' },
      { author: 'assistant', body: 'Your order is paying out.' },
    ],
    ...overrides,
  }
}

describe('support ticket repository', () => {
  it('files a ticket open, with the conversation copied in as its first messages', async () => {
    const { repo } = repoWithIds()
    const made = await repo.create(ticketFor(ALICE))
    expect(made).toMatchObject({ id: 't1', status: 'open', userUnread: false, chain: 'stellar' })

    const read = await repo.getForRequester('t1', ALICE)
    expect(read?.messages.map((m) => [m.author, m.body])).toEqual([
      ['user', 'my off-ramp is stuck'],
      ['assistant', 'Your order is paying out.'],
    ])
  })

  it("never shows one person's ticket to another", async () => {
    const { repo } = repoWithIds()
    await repo.create(ticketFor(ALICE))
    expect(await repo.getForRequester('t1', BOB)).toBeUndefined()
    expect(await repo.listForRequester(BOB)).toEqual([])
    expect(await repo.addUserMessage('t1', BOB, 'hijack')).toBe(false)
  })

  it('marks a team reply answered and unread, and reading clears it', async () => {
    const { repo } = repoWithIds()
    await repo.create(ticketFor(ALICE))
    expect(await repo.addAdminReply('t1', 'Looking into it now.')).toBe(true)

    const replied = await repo.getForRequester('t1', ALICE)
    expect(replied).toMatchObject({ status: 'answered', userUnread: true })
    expect(replied?.messages.at(-1)).toMatchObject({
      author: 'admin',
      body: 'Looking into it now.',
    })

    await repo.markRead('t1', ALICE)
    expect((await repo.getForRequester('t1', ALICE))?.userUnread).toBe(false)
  })

  it("reopens a ticket when the person replies, so it is the team's turn again", async () => {
    const { repo } = repoWithIds()
    await repo.create(ticketFor(ALICE))
    await repo.addAdminReply('t1', 'Can you share the time you sent it?')
    expect(await repo.addUserMessage('t1', ALICE, 'About 9am')).toBe(true)
    expect((await repo.get('t1'))?.status).toBe('open')
  })

  it('lists for the admin by status, kind and chain, newest activity first', async () => {
    const { repo } = repoWithIds()
    await repo.create(ticketFor(ALICE))
    await repo.create(ticketFor(BOB, { kind: 'suggestion', chain: 'near', title: 'Dark mode' }))
    await repo.create(ticketFor(BOB, { chain: 'sui' }))
    await repo.setStatus('t3', 'closed')

    expect((await repo.listAll({})).map((t) => t.id)).toEqual(['t3', 't2', 't1'])
    expect((await repo.listAll({ status: 'open' })).map((t) => t.id)).toEqual(['t2', 't1'])
    expect((await repo.listAll({ kind: 'suggestion' })).map((t) => t.id)).toEqual(['t2'])
    expect((await repo.listAll({ chain: 'stellar' })).map((t) => t.id)).toEqual(['t1'])
  })

  it('answers false for a ticket that does not exist', async () => {
    const { repo } = repoWithIds()
    expect(await repo.addAdminReply('missing', 'hi')).toBe(false)
    expect(await repo.setStatus('missing', 'closed')).toBe(false)
    expect(await repo.get('missing')).toBeUndefined()
  })
})
