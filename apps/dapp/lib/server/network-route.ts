import type { StellarNetworkName } from '@intent/config'

/**
 * Reading a network out of an address, for middleware. Pure and free of Node
 * imports: middleware runs on the edge.
 */

/** `stellar-mainnet` is mainnet, `stellar-testnet` is testnet; anything else names no network. */
export function segmentNetwork(segment: string): StellarNetworkName | undefined {
  if (segment === 'stellar-mainnet') return 'mainnet'
  if (segment === 'stellar-testnet') return 'testnet'
  return undefined
}

/**
 * Where a bare `/stellar/...` address goes when several networks are served,
 * or nothing when it should be left alone. Keeps the rest of the path and the
 * query, so an old link still opens the same screen on the default network.
 */
export function legacyStellarRedirect(
  pathname: string,
  search: string,
  multi: boolean,
  fallback: StellarNetworkName
): string | undefined {
  if (!multi) return undefined
  if (pathname !== '/stellar' && !pathname.startsWith('/stellar/')) return undefined
  return `/stellar-${fallback}${pathname.slice('/stellar'.length)}${search}`
}

/** Pages that are not part of the app's chain screens and are never behind the gate. */
const GATE_FREE = ['/verify', '/waitlist', '/admin']

export function isGateFree(pathname: string): boolean {
  return GATE_FREE.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
