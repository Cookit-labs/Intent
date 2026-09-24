import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAlertsRepo, type AlertsRepo } from '../server/alerts'
import type { AlertMail, RuleFiredMail } from '../server/email'
import { createStandingRulesRepo, type StandingRulesRepo } from '../server/standing-rules'
import { runTick, type SponsorWatch } from '../server/standing-tick'
import type { StandingIntent } from '../standing-intent'
import { fakeAlertsDb } from './fakes/alerts-db'
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
  alerts: { to: string; mail: AlertMail }[] = []
  /** Set to make the next send fail, once. */
  failNext = false
  failNextAlert = false

  async sendRuleFired(to: string, fired: RuleFiredMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('Resend failed (503)')
    }
    this.sent.push({ to, fired })
  }

  async sendAlert(to: string, mail: AlertMail): Promise<void> {
    if (this.failNextAlert) {
      this.failNextAlert = false
      throw new Error('Resend failed (503)')
    }
    this.alerts.push({ to, mail })
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

describe('the sponsor watch', () => {
  // The tick is the one thing that runs on a schedule, so it is also where
  // the fee sponsor's balance is looked at. An operator is told once a day
  // while it is low — once, because an alert every minute is one that gets
  // filtered — and never when nobody has asked to be told.
  const SPONSOR = 'G'.padEnd(56, 'S')
  const OPS = 'ops@test.com'

  let alerts: AlertsRepo
  let balanceXlm: string
  let funded: boolean
  let reads: number

  beforeEach(() => {
    alerts = createAlertsRepo(fakeAlertsDb().query)
    balanceXlm = '5.0000000'
    funded = true
    reads = 0
    // The alert is also reported as an event, which logs a line.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  function watched(now: string, over: Partial<SponsorWatch> = {}) {
    return runTick({
      now: new Date(now),
      prices: { XLM: 0.19 },
      repo,
      mailer,
      appUrl: APP_URL,
      sponsor: {
        account: SPONSOR,
        balance: async () => {
          reads += 1
          return { funded, balanceXlm }
        },
        alertBelowXlm: 20,
        alertEmail: OPS,
        alerts,
        ...over,
      },
    })
  }

  it('emails the operator when the balance is below the threshold', async () => {
    await watched('2026-09-23T11:00:00.000Z')

    expect(mailer.alerts).toHaveLength(1)
    expect(mailer.alerts[0]?.to).toBe(OPS)
    expect(mailer.alerts[0]?.mail.subject).toContain('5.0000000 XLM')
    expect(mailer.alerts[0]?.mail.text).toContain(SPONSOR)
    expect(mailer.alerts[0]?.mail.text).toContain('20 XLM')
  })

  it('does not email twice the same day, and stops reading the balance once told', async () => {
    await watched('2026-09-23T11:00:00.000Z')
    await watched('2026-09-23T11:01:00.000Z')
    await watched('2026-09-23T23:59:00.000Z')

    expect(mailer.alerts).toHaveLength(1)
    expect(reads).toBe(1)
  })

  it('emails again the next day while the balance stays low', async () => {
    await watched('2026-09-23T11:00:00.000Z')
    await watched('2026-09-24T00:01:00.000Z')

    expect(mailer.alerts).toHaveLength(2)
  })

  it('stays quiet while the sponsor holds at least the threshold', async () => {
    balanceXlm = '20.0000000'

    await watched('2026-09-23T11:00:00.000Z')

    expect(mailer.alerts).toHaveLength(0)
  })

  it('treats an unfunded sponsor as holding nothing', async () => {
    funded = false
    balanceXlm = '0'

    await watched('2026-09-23T11:00:00.000Z')

    expect(mailer.alerts).toHaveLength(1)
    expect(mailer.alerts[0]?.mail.subject).toContain('0 XLM')
  })

  it('sends nothing, and reads nothing, when ALERT_EMAIL is unset', async () => {
    await watched('2026-09-23T11:00:00.000Z', { alertEmail: undefined })

    expect(mailer.alerts).toHaveLength(0)
    expect(reads).toBe(0)
  })

  it('tries again next tick when the send fails', async () => {
    mailer.failNextAlert = true

    await watched('2026-09-23T11:00:00.000Z')
    expect(mailer.alerts).toHaveLength(0)

    await watched('2026-09-23T11:01:00.000Z')
    expect(mailer.alerts).toHaveLength(1)
  })

  it('neither alerts nor stops the tick when Horizon cannot say', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const result = await watched('2026-09-23T11:00:00.000Z', {
      balance: async () => {
        throw new Error('Horizon 503')
      },
    })

    expect(result).toEqual({ evaluated: 1, fired: 0, notified: 0 })
    expect(mailer.alerts).toHaveLength(0)
  })

  it('does not change what the rules pass does', async () => {
    await repo.createRule({ email: OWNER, wallet: WALLET, rule: rule() })

    const result = await runTick({
      now: new Date('2026-09-23T11:00:00.000Z'),
      prices: { XLM: 0.155 },
      repo,
      mailer,
      appUrl: APP_URL,
      sponsor: {
        account: SPONSOR,
        balance: async () => ({ funded: true, balanceXlm: '5.0000000' }),
        alertBelowXlm: 20,
        alertEmail: OPS,
        alerts,
      },
    })

    expect(result).toEqual({ evaluated: 1, fired: 1, notified: 1 })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.alerts).toHaveLength(1)
  })
})
