import type { StellarNetworkName } from '@intent/config'

import { runWithNetwork } from './network-context'
import type { TickResult } from './standing-tick'

/**
 * The scheduled rule check across every network a deployment serves.
 *
 * A scheduler calls the route with no request behind it, so there is no
 * network to read. Each one is named here, run on its own with that network
 * selected, and added into one result. A network that fails (its price source
 * is down, say) is reported and does not stop the others, because a mainnet
 * rule should not wait on testnet's outage.
 */
export async function tickAllNetworks(
  networks: readonly StellarNetworkName[],
  runOne: (network: StellarNetworkName) => Promise<TickResult>
): Promise<{ result: TickResult; failed: StellarNetworkName[] }> {
  const result: TickResult = { evaluated: 0, fired: 0, notified: 0 }
  const failed: StellarNetworkName[] = []

  for (const network of networks) {
    try {
      const one = await runWithNetwork(network, () => runOne(network))
      result.evaluated += one.evaluated
      result.fired += one.fired
      result.notified += one.notified
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[standing] the ${network} tick failed:`, e)
      failed.push(network)
    }
  }
  return { result, failed }
}
