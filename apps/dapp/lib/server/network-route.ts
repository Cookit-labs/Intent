import { homeSegment, parseChainSegment, type StellarNetworkName } from '@intent/config'

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

/** The screens that lived at the top level before there were chains. */
const BARE_SCREENS = [
  'intents',
  'agents',
  'apps',
  'analytics',
  'history',
  'vault',
  'competitions',
  'leaderboard',
]

/**
 * Where the bare root, and the old unprefixed screens, go. The root is the connect
 * page, so it stays put unless a chain is remembered from an earlier visit. The old
 * screens open on the home chain, keeping the rest of the path and the query.
 * Nothing for any other address.
 */
export function bareRedirect(
  pathname: string,
  search: string,
  home: string,
  remembered: string | undefined
): string | undefined {
  if (pathname === '/') {
    return remembered === undefined ? undefined : `/${remembered}/intents${search}`
  }
  const first = pathname.split('/')[1] ?? ''
  if (!BARE_SCREENS.includes(first)) return undefined
  return `/${home}${pathname}${search}`
}

/**
 * The chain last connected to, so a returning visitor goes back to their wallet.
 * It comes from a cookie anyone can edit, so it counts only if it names a real chain.
 */
export function rememberedChain(
  remembered: string | undefined,
  enabled: readonly StellarNetworkName[]
): string | undefined {
  return remembered !== undefined && parseChainSegment(remembered, enabled) !== undefined
    ? remembered
    : undefined
}

/** The chain an old unprefixed screen opens on. */
export function homeFor(
  remembered: string | undefined,
  enabled: readonly StellarNetworkName[]
): string {
  return rememberedChain(remembered, enabled) ?? homeSegment(enabled)
}

/** Pages that are not part of the app's chain screens and are never behind the gate. */
const GATE_FREE = ['/verify', '/waitlist', '/admin']

export function isGateFree(pathname: string): boolean {
  return GATE_FREE.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
