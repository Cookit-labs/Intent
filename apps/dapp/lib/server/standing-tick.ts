import type { SponsorBalance } from '../sponsor/balance'
import { describeTrigger, evaluateTrigger } from '../standing-intent'
import type { AlertsRepo } from './alerts'
import type { AlertMail, EmailSender } from './email'
import { reportEvent } from './report'
import type { StandingRulesRepo, StoredStandingRule } from './standing-rules'

/**
 * One pass over every armed rule: fire the ones whose condition is met, and
 * tell their owners.
 *
 * This is what makes a rule fire with no tab open. It is called on a schedule
 * — a cron, a scheduled function, or the dev loop in scripts/standing-tick.ts
 * — and it must be safe to call as often as anyone likes.
 *
 * **It decides and it tells. It never trades.** A firing writes a row and
 * sends an email; the user signs on their next visit, exactly as a due rule
 * asks for a signature when the tab is open. That is the whole reason a
 * server-side watcher is acceptable: nothing here holds a key, so nothing here
 * can spend. Autonomous execution would mean pre-signed transactions, which
 * is a different and much larger security question.
 *
 * **Idempotent by construction.** Firing and notifying are separate steps
 * with separate marks. A one-off rule that fired is no longer armed and is
 * never evaluated again; a scheduled rule carries its last firing forward, so
 * the evaluator declines until the next interval. A failed email leaves
 * `notified_at` null, so the next tick sends it — but sending reads the
 * original firing's price and time, and never re-evaluates the rule. Duplicate
 * prompts to trade would be a real bug someone receives as email.
 *
 * **It also keeps an eye on the fee sponsor**, because it is the one thing
 * that runs on a schedule. After the rules pass it reads the sponsor's
 * balance and, when that is below the threshold, tells the operator — once
 * a day, recorded in `alerts_sent`, because an alert that repeats every
 * minute is one that gets filtered. A balance that cannot be read is not a
 * low balance: nothing is sent, and the rules pass is unaffected either way.
 */

export interface TickInput {
  now: Date
  /** Symbol → USD, as the evaluator expects. */
  prices: Record<string, number>
  repo: Pick<StandingRulesRepo, 'armedRules' | 'markFired' | 'unnotifiedFired' | 'markNotified'>
  mailer: Pick<EmailSender, 'sendRuleFired' | 'sendAlert'>
  /** Origin the email links into, e.g. https://intent.example. */
  appUrl: string
  /** The sponsor to watch. Absent when none is configured. */
  sponsor?: SponsorWatch
}

export interface SponsorWatch {
  /** The sponsor's public key, for the message. Never the secret. */
  account: string
  /** What the sponsor holds; throws when Horizon cannot say. */
  balance: () => Promise<SponsorBalance>
  /** Below this many XLM the operator is told. */
  alertBelowXlm: number
  /** Who to tell. Undefined means nobody asked, so nothing is read or sent. */
  alertEmail: string | undefined
  alerts: Pick<AlertsRepo, 'wasSent' | 'markSent'>
}

export interface TickResult {
  /** Armed rules looked at. */
  evaluated: number
  /** Rules whose condition was met this pass. */
  fired: number
  /** Emails that went out, including retries from earlier passes. */
  notified: number
}

function ruleLink(appUrl: string, rule: StoredStandingRule): string {
  return `${appUrl.replace(/\/+$/, '')}/${rule.chain}/intents?rule=${encodeURIComponent(rule.id)}`
}

const LOW_BALANCE = 'sponsor_low_balance'

/** The UTC date, which is what "once a day" is measured in. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function lowBalanceMail(watch: SponsorWatch, balanceXlm: string): AlertMail {
  return {
    subject: `Sponsor balance low: ${balanceXlm} XLM`,
    text: [
      `The fee sponsor is running low.`,
      ``,
      `  account:   ${watch.account}`,
      `  balance:   ${balanceXlm} XLM`,
      `  threshold: ${watch.alertBelowXlm} XLM`,
      ``,
      `Fund the account to keep covering users' fees. Until then submissions`,
      `still go through — each user pays their own fee, as before sponsorship.`,
      ``,
      `This is sent once a day while the balance stays below the threshold.`,
    ].join('\n'),
  }
}

/**
 * Tells the operator once a day while the sponsor is low. The record is
 * written after the send, so a failed send is tried again next tick; the
 * record is read before the balance, so a sponsor already reported today
 * costs nothing more.
 */
async function watchSponsor(
  watch: SponsorWatch,
  mailer: Pick<EmailSender, 'sendAlert'>,
  now: Date
): Promise<void> {
  if (watch.alertEmail === undefined) return
  const day = utcDay(now)

  try {
    if (await watch.alerts.wasSent(LOW_BALANCE, day)) return

    const { balanceXlm } = await watch.balance()
    if (Number(balanceXlm) >= watch.alertBelowXlm) return

    reportEvent('sponsor.low_balance', {
      account: watch.account,
      balanceXlm,
      threshold: watch.alertBelowXlm,
    })
    await mailer.sendAlert(watch.alertEmail, lowBalanceMail(watch, balanceXlm))
    await watch.alerts.markSent(LOW_BALANCE, day)
  } catch (e) {
    // Horizon down, or the send refused. Neither is a low balance, and
    // neither may stop the rules pass that already happened from returning.
    // eslint-disable-next-line no-console
    console.warn('[standing] could not check the sponsor balance:', e)
  }
}

export async function runTick(input: TickInput): Promise<TickResult> {
  const { now, prices, repo, mailer, appUrl, sponsor } = input

  const armed = await repo.armedRules()
  let fired = 0

  for (const stored of armed) {
    const verdict = evaluateTrigger(stored.rule, prices, now)
    if (!verdict.fires) continue

    // The price recorded is the one the decision was made on, so the email
    // and the inbox can say what crossed the level. A schedule has none.
    const trigger = stored.rule.trigger
    const price = trigger.kind === 'schedule' ? null : (prices[trigger.asset] ?? null)

    await repo.markFired(stored.id, price, now)
    fired += 1
  }

  // Notification is a second pass over *everything* fired and untold, not
  // over what fired just now. That is what makes a failed send retry: the
  // row is still fired and still unnotified on the next tick.
  let notified = 0
  for (const stored of await repo.unnotifiedFired()) {
    const mail = {
      description: describeTrigger(stored.rule),
      ...(stored.firedPrice !== null ? { price: stored.firedPrice } : {}),
      link: ruleLink(appUrl, stored),
    }

    try {
      await mailer.sendRuleFired(stored.email, mail)
    } catch (e) {
      // Left unnotified so the next tick tries again. Logged rather than
      // thrown: one owner's unverified domain must not stop the rest of the
      // pass, and the tick's caller can see the count did not match.
      // eslint-disable-next-line no-console
      console.warn(`[standing] could not email ${stored.email} about ${stored.id}:`, e)
      continue
    }

    await repo.markNotified(stored.id, now)
    notified += 1
  }

  if (sponsor !== undefined) await watchSponsor(sponsor, mailer, now)

  return { evaluated: armed.length, fired, notified }
}
