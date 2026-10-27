import { activeNetwork } from '@intent/config'
import { NextResponse } from 'next/server'

import { readAgentHealth, type AgentHealthReport } from '../../../../lib/server/agent-health'
import { alertRecipient, getAlertsRepo } from '../../../../lib/server/alerts'
import { getEmailSender } from '../../../../lib/server/email'
import { getPool, withTimeout } from '../../../../lib/server/db'

/**
 * The scheduled check of whether the agent roster is actually answering.
 *
 * GET, authenticated with `CRON_SECRET`, because that is what Vercel Cron
 * actually sends and the method it actually calls with — a GET request
 * carrying `Authorization: Bearer <CRON_SECRET>` — rather than the POST and
 * custom header `standing/tick` uses, which was never wired to a scheduler
 * in the first place (no `vercel.json` existed before this). Safe to call
 * repeatedly: an alert goes out at most once per severity per day
 * (`alerts_sent`, the same table the sponsor-balance alert uses).
 *
 * This replaces someone running curl against production and reading Vercel
 * logs by hand to notice a dead or rate-limited model. It reads the races
 * the app already logs rather than running a synthetic race of its own; see
 * `agent-health.ts` for why.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_SECRET_LENGTH = 16
const ALERT_KIND = 'agent_health'

function authorised(request: Request, expected: string): boolean {
  return request.headers.get('authorization') === `Bearer ${expected}`
}

function alertText(report: AgentHealthReport): { subject: string; text: string } {
  const pct = report.answerRate !== undefined ? `${(report.answerRate * 100).toFixed(0)}%` : 'n/a'
  return {
    subject: `[Intent] Agent health: ${report.severity} on ${report.network}`,
    text: [
      `Agent answer rate over the last ${report.window.hours}h: ${pct} ` +
        `(${report.answeredTotal}/${report.askedTotal} asks, ${report.window.races} races).`,
      ``,
      ...report.reasons.map((r) => `- ${r}`),
      ``,
      `Per-agent, this window:`,
      ...report.coreAgents.map((a) => `  ${a.agent}: ${a.answered}/${a.races}`),
    ].join('\n'),
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env['CRON_SECRET']
  if (expected === undefined || expected.length < MIN_SECRET_LENGTH) {
    return NextResponse.json(
      {
        error: `CRON_SECRET is not set (or is shorter than ${MIN_SECRET_LENGTH} characters). Refusing to run an open check.`,
      },
      { status: 503 }
    )
  }
  if (!authorised(request, expected)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const pool = getPool()
  const report = await readAgentHealth(async (sql, params) => {
    const result = await withTimeout(pool.query(sql, params), 8_000)
    return { rows: result.rows as Record<string, unknown>[] }
  }, activeNetwork())

  if (report.severity === 'warning' || report.severity === 'critical') {
    const to = alertRecipient()
    if (to !== undefined) {
      const alerts = await getAlertsRepo()
      const day = new Date().toISOString().slice(0, 10)
      const kind = `${ALERT_KIND}:${report.severity}:${report.network}`
      if (!(await alerts.wasSent(kind, day))) {
        await getEmailSender().sendAlert(to, alertText(report))
        await alerts.markSent(kind, day)
      }
    }
  }

  return NextResponse.json(report)
}
