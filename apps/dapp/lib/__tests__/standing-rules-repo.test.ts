import { beforeEach, describe, expect, it } from 'vitest'

import { createStandingRulesRepo, type StandingRulesRepo } from '../server/standing-rules'
import type { StandingIntent } from '../standing-intent'
import { fakeStandingRulesDb, type FakeDb } from './fakes/standing-rules-db'

/**
 * The server-side record of standing rules.
 *
 * Rules used to live only in localStorage, which meant they were watched only
 * while a tab was open. Moving them to Postgres is what lets a scheduled tick
 * evaluate them unattended — so the repository has to hold everything the tick
 * and the inbox need: who owns a rule, whether it has fired, at what price,
 * whether the owner has been told, and whether they have looked.
 */

let db: FakeDb
let repo: StandingRulesRepo

beforeEach(() => {
  db = fakeStandingRulesDb()
  repo = createStandingRulesRepo(db.query)
})

function rule(over: Partial<StandingIntent> = {}): StandingIntent {
  return {
    id: 'si_1',
    chain: 'stellar',
    text: 'Buy $50 of XLM if it drops to $0.16',
    createdAt: '2026-09-23T10:00:00.000Z',
    trigger: { kind: 'price_below', asset: 'XLM', priceUsd: 0.16 },
    action: { kind: 'swap', from: 'USDC', to: 'XLM', amountIn: '50' },
    status: 'armed',
    ...over,
  }
}

const OWNER = 'alice@test.com'
const WALLET = 'G'.padEnd(56, 'A')

describe('creating and listing', () => {
  it('stores a rule under its owner and lists it back', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const listed = await repo.listRules(OWNER, 'stellar')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.rule.text).toBe('Buy $50 of XLM if it drops to $0.16')
    expect(listed[0]?.wallet).toBe(WALLET)
    expect(listed[0]?.status).toBe('armed')
  })

  it('scopes listing to the owner and the chain', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'b', chain: 'arc' }) })
    await repo.createRule({ email: 'bob@test.com', wallet: WALLET, rule: rule({ id: 'c' }) })

    expect((await repo.listRules(OWNER, 'stellar')).map((r) => r.id)).toEqual(['a'])
  })

  it('re-saving a rule replaces it rather than duplicating it', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'same' }) })
    await repo.createRule({
      email: OWNER,
      wallet: WALLET,
      rule: rule({ id: 'same', text: 'edited' }),
    })

    const listed = await repo.listRules(OWNER, 'stellar')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.rule.text).toBe('edited')
  })

  it('refuses to overwrite a rule owned by someone else', async () => {
    // Ids come from the client and are guessable. Ownership is checked on
    // every write, not just on reads.
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })

    const stolen = await repo.createRule({
      email: 'mallory@test.com',
      wallet: WALLET,
      rule: rule({ id: 'x', text: 'hijacked' }),
    })

    expect(stolen).toBeUndefined()
    expect((await repo.listRules(OWNER, 'stellar'))[0]?.rule.text).not.toBe('hijacked')
  })

  it('the column status wins over whatever status the rule JSON carries', async () => {
    // The client posts its own copy of the rule, which may be stale. The
    // server's column is the record.
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })
    await repo.markFired('x', 0.15, new Date('2026-09-23T11:00:00.000Z'))
    await repo.createRule({
      email: OWNER,
      wallet: WALLET,
      rule: rule({ id: 'x', status: 'armed' }),
    })

    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('fired')
    expect(found?.rule.status).toBe('fired')
  })
})

describe('cancelling', () => {
  it('stops a rule without deleting it', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })
    expect(await repo.cancelRule(OWNER, 'x')).toBe(true)

    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('cancelled')
    expect(await repo.armedRules()).toHaveLength(0)
  })

  it('cannot cancel another owner’s rule', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })
    expect(await repo.cancelRule('mallory@test.com', 'x')).toBe(false)
    expect((await repo.listRules(OWNER, 'stellar'))[0]?.status).toBe('armed')
  })
})

describe('firing', () => {
  it('lists only armed rules for the tick', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'b' }) })
    await repo.cancelRule(OWNER, 'b')

    expect((await repo.armedRules()).map((r) => r.id)).toEqual(['a'])
  })

  it('marks a one-off rule fired with the price and time', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })
    await repo.markFired('x', 0.155, new Date('2026-09-23T11:00:00.000Z'))

    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('fired')
    expect(found?.firedAt).toBe('2026-09-23T11:00:00.000Z')
    expect(found?.firedPrice).toBe(0.155)
    expect(found?.notifiedAt).toBeNull()
    expect(found?.seenAt).toBeNull()
    expect(await repo.armedRules()).toHaveLength(0)
  })

  it('keeps a scheduled rule armed and moves its last firing forward', async () => {
    // A weekly buy recurs. The trigger evaluator measures the next interval
    // from `lastFiredAt`, so that is what the row has to carry back.
    await repo.createRule({
      email: OWNER,
      wallet: WALLET,
      rule: rule({ id: 'weekly', trigger: { kind: 'schedule', everyHours: 168 } }),
    })
    await repo.markFired('weekly', null, new Date('2026-09-23T11:00:00.000Z'))

    const [armed] = await repo.armedRules()
    expect(armed?.id).toBe('weekly')
    expect(armed?.status).toBe('armed')
    expect(armed?.rule.lastFiredAt).toBe('2026-09-23T11:00:00.000Z')
    expect(armed?.firedPrice).toBeNull()
  })

  it('does not fire a rule that is not armed', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'x' }) })
    await repo.cancelRule(OWNER, 'x')
    await repo.markFired('x', 0.1, new Date('2026-09-23T11:00:00.000Z'))

    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('cancelled')
    expect(found?.firedAt).toBeNull()
  })
})

describe('notifying', () => {
  it('lists fired rules whose owner has not been told', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'b' }) })
    await repo.markFired('a', 0.1, new Date('2026-09-23T11:00:00.000Z'))

    expect((await repo.unnotifiedFired()).map((r) => r.id)).toEqual(['a'])

    await repo.markNotified('a', new Date('2026-09-23T11:00:05.000Z'))
    expect(await repo.unnotifiedFired()).toHaveLength(0)
    expect((await repo.listRules(OWNER, 'stellar')).find((r) => r.id === 'a')?.notifiedAt).toBe(
      '2026-09-23T11:00:05.000Z'
    )
  })
})

describe('the inbox', () => {
  it('lists fired rules the owner has not looked at, newest firing first', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'b' }) })
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'c' }) })
    await repo.markFired('a', 0.1, new Date('2026-09-23T11:00:00.000Z'))
    await repo.markFired('b', 0.1, new Date('2026-09-23T12:00:00.000Z'))

    expect((await repo.unseenFired(OWNER, 'stellar')).map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('marking seen removes items from the inbox but not from the list', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.markFired('a', 0.1, new Date('2026-09-23T11:00:00.000Z'))
    await repo.markSeen(OWNER, ['a'], new Date('2026-09-23T13:00:00.000Z'))

    expect(await repo.unseenFired(OWNER, 'stellar')).toHaveLength(0)
    const [found] = await repo.listRules(OWNER, 'stellar')
    expect(found?.status).toBe('fired')
    expect(found?.seenAt).toBe('2026-09-23T13:00:00.000Z')
  })

  it('only the owner can mark a rule seen', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.markFired('a', 0.1, new Date('2026-09-23T11:00:00.000Z'))
    await repo.markSeen('mallory@test.com', ['a'], new Date('2026-09-23T13:00:00.000Z'))

    expect(await repo.unseenFired(OWNER, 'stellar')).toHaveLength(1)
  })

  it('a scheduled rule that fired again reappears in the inbox', async () => {
    await repo.createRule({
      email: OWNER,
      wallet: WALLET,
      rule: rule({ id: 'weekly', trigger: { kind: 'schedule', everyHours: 168 } }),
    })
    await repo.markFired('weekly', null, new Date('2026-09-23T11:00:00.000Z'))
    await repo.markSeen(OWNER, ['weekly'], new Date('2026-09-23T12:00:00.000Z'))
    await repo.markNotified('weekly', new Date('2026-09-23T11:00:05.000Z'))
    await repo.markFired('weekly', null, new Date('2026-09-30T11:00:00.000Z'))

    expect((await repo.unseenFired(OWNER, 'stellar')).map((r) => r.id)).toEqual(['weekly'])
    expect((await repo.unnotifiedFired()).map((r) => r.id)).toEqual(['weekly'])
  })
})

describe('the schema', () => {
  it('is created lazily with idempotent statements', async () => {
    // Migration files are mounted into Postgres only at first container init,
    // so an existing database never runs a new file. The module creates the
    // table itself, with `IF NOT EXISTS`, so both fresh and existing databases
    // work without an operator step.
    await repo.ensureSchema()
    await repo.ensureSchema()

    const ddl = db.log.filter((s) => s.startsWith('CREATE'))
    expect(ddl.length).toBeGreaterThan(0)
    expect(ddl.every((s) => s.includes('IF NOT EXISTS'))).toBe(true)
  })
})
