import { AsyncLocalStorage } from 'node:async_hooks'

import {
  NETWORK_HEADER,
  defaultNetwork,
  enabledNetworks,
  resolveRequestedNetwork,
  setNetworkResolver,
  type StellarNetworkName,
} from '@intent/config'
import { headers } from 'next/headers'

/**
 * The Stellar network of the work in progress, on the server.
 *
 * Two sources, in this order. `runWithNetwork` pins a network for work that is
 * not a request (the scheduled rule check, a script, a test). Otherwise it is
 * the `x-intent-network` header that middleware set, which is the only copy of
 * the network a route trusts: middleware overwrites whatever the client sent
 * with a value it validated against the networks this deployment serves.
 *
 * Neither source present means there is no answer, and `activeNetwork()`
 * throws rather than defaulting.
 */
const pinned = new AsyncLocalStorage<StellarNetworkName>()

export function runWithNetwork<T>(network: StellarNetworkName, fn: () => T): T {
  return pinned.run(network, fn)
}

function networkOfCurrentWork(): StellarNetworkName | undefined {
  const fixed = pinned.getStore()
  if (fixed !== undefined) return fixed

  let value: string | null
  try {
    value = headers().get(NETWORK_HEADER)
  } catch {
    // Outside a request: a job, a script, or module load.
    return undefined
  }
  if (value === null) return undefined
  return resolveRequestedNetwork(value, enabledNetworks(), defaultNetwork())
}

/** Called once from the server's boot hook. */
export function installNetworkResolver(): void {
  setNetworkResolver(networkOfCurrentWork)
}
