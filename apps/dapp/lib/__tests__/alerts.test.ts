import { beforeEach, describe, expect, it } from 'vitest'

import {
  alertRecipient,
  createAlertsRepo,
  sponsorAlertThreshold,
  type AlertsRepo,
} from '../server/alerts'
import { fakeAlertsDb, type FakeAlertsDb } from './fakes/alerts-db'

/**
 * The record of operator alerts, and the two settings that govern the
 * sponsor one.
 *
 * An alert that repeats every minute is one that gets filtered, so each
 * kind goes out at most once a day. The repository is the memory of that:
 * a row per kind per day, and nothing else.
 */

let db: FakeAlertsDb
let repo: AlertsRepo

beforeEach(() => {
  db = fakeAlertsDb()
  repo = createAlertsRepo(db.query)
})

describe('the alerts record', () => {
  it('remembers that a kind went out on a day', async () => {
    expect(await repo.wasSent('sponsor_low_balance', '2026-09-23')).toBe(false)

    await repo.markSent('sponsor_low_balance', '2026-09-23')

    expect(await repo.wasSent('sponsor_low_balance', '2026-09-23')).toBe(true)
  })

  it('keeps days and kinds apart', async () => {
    await repo.markSent('sponsor_low_balance', '2026-09-23')

    expect(await repo.wasSent('sponsor_low_balance', '2026-09-24')).toBe(false)
    expect(await repo.wasSent('something_else', '2026-09-23')).toBe(false)
  })

  it('marking twice is not an error', async () => {
    await repo.markSent('sponsor_low_balance', '2026-09-23')
    await repo.markSent('sponsor_low_balance', '2026-09-23')

    expect(db.sent.size).toBe(1)
  })
})

describe('alertRecipient', () => {
  it('is nobody when ALERT_EMAIL is unset or empty', () => {
    expect(alertRecipient({})).toBeUndefined()
    expect(alertRecipient({ ALERT_EMAIL: '' })).toBeUndefined()
    expect(alertRecipient({ ALERT_EMAIL: '   ' })).toBeUndefined()
  })

  it('is the configured address', () => {
    expect(alertRecipient({ ALERT_EMAIL: ' ops@test.com ' })).toBe('ops@test.com')
  })
})

describe('sponsorAlertThreshold', () => {
  it('is 20 XLM unless SPONSOR_ALERT_XLM says otherwise', () => {
    expect(sponsorAlertThreshold({})).toBe(20)
    expect(sponsorAlertThreshold({ SPONSOR_ALERT_XLM: '5' })).toBe(5)
    expect(sponsorAlertThreshold({ SPONSOR_ALERT_XLM: '2.5' })).toBe(2.5)
  })

  it('falls back to the default rather than alerting on nonsense', () => {
    expect(sponsorAlertThreshold({ SPONSOR_ALERT_XLM: 'lots' })).toBe(20)
    expect(sponsorAlertThreshold({ SPONSOR_ALERT_XLM: '0' })).toBe(20)
    expect(sponsorAlertThreshold({ SPONSOR_ALERT_XLM: '' })).toBe(20)
  })
})
