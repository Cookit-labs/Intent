import { NextResponse } from 'next/server'

import { checkHealth, defaultProbes, healthStatus, networkLabel } from '../../../lib/server/health'

/**
 * Whether this deployment can serve.
 *
 * 200 when the database, Horizon and the RPC answer; 503 otherwise, with each
 * check's timing and reason in the body so a monitor page can say which one.
 * The sponsor is reported alongside but does not decide the status — see
 * lib/server/health.ts for why. Never cached: a health answer from a minute
 * ago is not an answer.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const report = await checkHealth({ probes: defaultProbes(), network: networkLabel() })
  return NextResponse.json(report, {
    status: healthStatus(report),
    headers: { 'Cache-Control': 'no-store' },
  })
}
