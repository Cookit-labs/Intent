import { NextResponse } from 'next/server'

import {
  cachedHealth,
  checkHealth,
  defaultProbes,
  healthStatus,
  networkLabel,
} from '../../../lib/server/health'

/**
 * Whether this deployment can serve.
 *
 * 200 when the database, Horizon and the RPC answer; 503 otherwise, with each
 * check's timing and reason in the body so a monitor page can say which one.
 * The sponsor is reported alongside but does not decide the status — see
 * lib/server/health.ts for why. Held for ten seconds server-side so a burst of
 * requests costs one round of upstream probes, and never cached by clients.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const current = cachedHealth(
  () => checkHealth({ probes: defaultProbes(), network: networkLabel() }),
  10_000
)

export async function GET(): Promise<NextResponse> {
  const report = await current()
  return NextResponse.json(report, {
    status: healthStatus(report),
    headers: { 'Cache-Control': 'no-store' },
  })
}
