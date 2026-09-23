import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuleFiredMail } from '../server/email'
import { createStandingRulesRepo, type StandingRulesRepo } from '../server/standing-rules'
import { runTick } from '../server/standing-tick'
import type { StandingIntent } from '../standing-intent'
import { fakeStandingRulesDb } from './fakes/standing-rules-db'

/**
 * The tick: what runs on a schedule so rules fire with no tab open.
 *
 * It decides and it tells. It never trades — a firing writes a row and sends
 * an email, and the user signs (or does not) on their next visit. That is the
 * whole reason a server-side watcher is acceptable: nothing here can spend.
 *
 * Idempotency is the property everything else rests on. The tick runs every
 * minute for as long as the app is deployed, and every way it could repeat
 * itself — re-firing a spent rule, re-emailing a notified one, firing a
 * schedule twice in one interval — is a real bug someone would receive as
 * duplicate email or a duplicate prompt to trade.
 */

interface Sent {
  to: string
  fired: RuleFiredMail
}

class FakeMailer {
  sent: Sent[] = []
  /** Set to make the next send fail, once. */
  failNext = false

  async sendRuleFired(to: string, fired: RuleFiredMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('Resend failed (503)')
    }
    this.sent.push({ to, fired })
  }
}

const APP_URL = 'https://intent.example'
const OWNER = 'alice@test.com'
const WALLET = 'G'.padEnd(56, 'A')

let repo: StandingRulesRepo
let mailer: FakeMailer

beforeEach(() => {
  repo = createStandingRulesRepo(fakeStandingRulesDb().query)
  mailer = new FakeMailer()
  // A failed send is logged, not thrown. Silenced here so the intentional
  // failures below do not read as test noise.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
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

function tick(now: string, prices: Record<string, number>) {
  return runTick({ now: new Date(now), prices, repo, mailer, appUrl: APP_URL })
}

describe('a price rule', () => {
  it('fires when the price crosses the level, and says so once', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const result = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.155 })

    expect(result).toEqual({ evaluated: 1, fired: 1, notified: 1 })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe(OWNER)
    expect(mailer.sent[0]?.fired.description).toBe('50 USDC → XLM when XLM falls to $0.16')
    expect(mailer.sent[0]?.fired.price).toBe(0.155)
    expect(mailer.sent[0]?.fired.link).toBe(`${APP_URL}/stellar/intents?rule=si_1`)

    const [row] = await repo.listRules(OWNER, 'stellar')
    expect(row?.status).toBe('fired')
    expect(row?.firedPrice).toBe(0.155)
    expect(row?.notifiedAt).not.toBeNull()
  })

  it('stays armed while the price is above the level', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const result = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.19 })

    expect(result).toEqual({ evaluated: 1, fired: 0, notified: 0 })
    expect(mailer.sent).toHaveLength(0)
    expect((await repo.listRules(OWNER, 'stellar'))[0]?.status).toBe('armed')
  })

  it('does not fire without a price for its asset', async () => {
    // Missing data is not a signal. Firing on an absent price would trade on
    // the failure of a feed, not on the market.
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const result = await tick('2026-09-23T11:00:00.000Z', {})

    expect(result.fired).toBe(0)
  })

  it('never fires twice', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })
    await tick('2026-09-23T11:00:00.000Z', { XLM: 0.155 })

    const again = await tick('2026-09-23T11:01:00.000Z', { XLM: 0.15 })

    expect(again).toEqual({ evaluated: 0, fired: 0, notified: 0 })
    expect(mailer.sent).toHaveLength(1)
  })
})

describe('when the email fails', () => {
  it('retries on the next tick without firing again', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })
    mailer.failNext = true

    const first = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.155 })
    expect(first).toEqual({ evaluated: 1, fired: 1, notified: 0 })
    expect((await repo.listRules(OWNER, 'stellar'))[0]?.notifiedAt).toBeNull()

    const second = await tick('2026-09-23T11:01:00.000Z', { XLM: 0.15 })
    expect(second).toEqual({ evaluated: 0, fired: 0, notified: 1 })

    expect(mailer.sent).toHaveLength(1)
    // Still the original firing: the retry carries the price that crossed,
    // not the price at retry time.
    expect(mailer.sent[0]?.fired.price).toBe(0.155)
    const [row] = await repo.listRules(OWNER, 'stellar')
    expect(row?.firedAt).toBe('2026-09-23T11:00:00.000Z')
    expect(row?.notifiedAt).not.toBeNull()
  })

  it('one owner’s failed send does not stop another’s', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule({ id: 'a' }) })
    await repo.createRule({ email: 'bob@test.com', wallet: WALLET, rule: rule({ id: 'b' }) })
    mailer.failNext = true

    const result = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.155 })

    expect(result).toEqual({ evaluated: 2, fired: 2, notified: 1 })
    expect(mailer.sent).toHaveLength(1)
  })
})

describe('a scheduled rule', () => {
  const weekly = rule({
    id: 'weekly',
    text: 'Every week swap 50 USDC to XLM',
    trigger: { kind: 'schedule', everyHours: 168 },
  })

  it('fires immediately the first time, then once per interval', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: weekly })

    const first = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.19 })
    expect(first).toEqual({ evaluated: 1, fired: 1, notified: 1 })
    expect(mailer.sent[0]?.fired.description).toBe('50 USDC → XLM every 1 week')
    expect(mailer.sent[0]?.fired.price).toBeUndefined()

    // An hour later: evaluated (still armed), not due.
    const soon = await tick('2026-09-23T12:00:00.000Z', { XLM: 0.19 })
    expect(soon).toEqual({ evaluated: 1, fired: 0, notified: 0 })

    // A week later: due again, and the owner is told again.
    const later = await tick('2026-09-30T11:00:00.000Z', { XLM: 0.19 })
    expect(later).toEqual({ evaluated: 1, fired: 1, notified: 1 })
    expect(mailer.sent).toHaveLength(2)

    const [row] = await repo.listRules(OWNER, 'stellar')
    expect(row?.status).toBe('armed')
    expect(row?.firedAt).toBe('2026-09-30T11:00:00.000Z')
  })
})

describe('a cancelled rule', () => {
  it('is neither evaluated nor emailed', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })
    await repo.cancelRule(OWNER, 'si_1')

    const result = await tick('2026-09-23T11:00:00.000Z', { XLM: 0.1 })

    expect(result).toEqual({ evaluated: 0, fired: 0, notified: 0 })
    expect(mailer.sent).toHaveLength(0)
  })
})
