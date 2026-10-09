import { defaultNetwork, enabledNetworks, type StellarNetworkName } from '@intent/config'
import { NextResponse } from 'next/server'

import {
  cachedHealth,
  checkHealth,
  defaultProbes,
  healthNetwork,
  healthStatus,
  type HealthReport,
} from '../../../lib/server/health'
import { runWithNetwork } from '../../../lib/server/network-context'

/**
 * Whether this deployment can serve.
 *
 * 200 when the database, Horizon and the RPC answer; 503 otherwise, with each
 * check's timing and reason in the body so a monitor page can say which one.
 * The sponsor is reported alongside but does not decide the status — see
 * lib/server/health.ts for why. Held for ten seconds server-side so a burst of
 * requests costs one round of upstream probes, and never cached by clients.
 *
 * With several Stellar networks served, `?network=mainnet` or `?network=testnet`
 * asks about one of them, each held separately; without it the answer is for
 * the deployment's default network, so an existing monitor keeps working.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const held = new Map<StellarNetworkName, () => Promise<HealthReport>>()

function reportFor(network: StellarNetworkName): Promise<HealthReport> {
  let current = held.get(network)
  if (current === undefined) {
    current = cachedHealth(
      () => runWithNetwork(network, () => checkHealth({ probes: defaultProbes(), network })),
      10_000
    )
    held.set(network, current)
  }
  return current()
}

export async function GET(request: Request): Promise<NextResponse> {
  const network = healthNetwork(request.url, enabledNetworks(), defaultNetwork())
  const report = await reportFor(network)
  return NextResponse.json(report, {
    status: healthStatus(report),
    headers: { 'Cache-Control': 'no-store' },
  })
}
