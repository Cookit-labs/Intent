/**
 * Which Stellar network a call is for.
 *
 * A deployment names the networks it serves in `NEXT_PUBLIC_STELLAR_NETWORKS`
 * (a comma list) and its default in `NEXT_PUBLIC_STELLAR_NETWORK`. With the
 * list unset only the default is served, and everything here collapses to the
 * single fixed value the app has always had: no resolver is consulted and
 * nothing is read from a request.
 *
 * With several networks served, the network belongs to the request. On the
 * server a resolver, installed at boot, answers from the request that is
 * running; in the browser the page sets it once from its URL. Neither falls
 * back silently: a call that cannot say which network it is for fails, because
 * running it on the default network is how a mainnet request ends up on
 * testnet, or the reverse.
 *
 * Every env read is a literal `process.env['NEXT_PUBLIC_…']`, the one form
 * Next.js inlines into the browser bundle.
 */
export type StellarNetworkName = 'testnet' | 'mainnet'

/** The request header middleware sets, and the only place server code reads the network from. */
export const NETWORK_HEADER = 'x-intent-network'

const NETWORK_ENV = 'NEXT_PUBLIC_STELLAR_NETWORK'
const NETWORKS_ENV = 'NEXT_PUBLIC_STELLAR_NETWORKS'

/** The flag's value as a network, or a thrown misconfiguration. Pure, for tests. */
export function parseStellarNetwork(raw: string | undefined): StellarNetworkName {
  const value = raw?.trim() ?? ''
  if (value === '' || value === 'testnet') return 'testnet'
  if (value === 'mainnet') return 'mainnet'
  throw new Error(
    `${NETWORK_ENV} must be "testnet" (the default) or "mainnet", not "${value}". ` +
      'Unset it to stay on testnet.'
  )
}

/** The deployment's default network: what `/stellar`, background work and a request with no network use. */
export function defaultNetwork(): StellarNetworkName {
  return parseStellarNetwork(process.env['NEXT_PUBLIC_STELLAR_NETWORK'])
}

/** The networks a list names, always including the default. Pure, for tests. */
export function parseEnabledNetworks(
  raw: string | undefined,
  fallback: StellarNetworkName
): StellarNetworkName[] {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (items.length === 0) return [fallback]

  const out: StellarNetworkName[] = []
  for (const item of items) {
    if (item !== 'testnet' && item !== 'mainnet') {
      throw new Error(`${NETWORKS_ENV} lists "${item}"; each entry must be "testnet" or "mainnet".`)
    }
    if (!out.includes(item)) out.push(item)
  }
  if (!out.includes(fallback)) {
    throw new Error(
      `${NETWORKS_ENV} must include the default network "${fallback}" (${NETWORK_ENV}).`
    )
  }
  return out
}

let memo:
  | { raw: string | undefined; fallback: StellarNetworkName; value: StellarNetworkName[] }
  | undefined

/** The networks this deployment serves. */
export function enabledNetworks(): StellarNetworkName[] {
  const raw = process.env['NEXT_PUBLIC_STELLAR_NETWORKS']
  const fallback = defaultNetwork()
  if (memo !== undefined && memo.raw === raw && memo.fallback === fallback) return memo.value
  const value = parseEnabledNetworks(raw, fallback)
  memo = { raw, fallback, value }
  return value
}

export function isMultiNetwork(): boolean {
  return enabledNetworks().length > 1
}

/** A requested network if this deployment serves it, otherwise the fallback. */
export function resolveRequestedNetwork(
  requested: string | null | undefined,
  enabled: readonly StellarNetworkName[],
  fallback: StellarNetworkName
): StellarNetworkName {
  return enabled.find((n) => n === requested) ?? fallback
}

type Resolver = () => StellarNetworkName | undefined

/**
 * Held on `globalThis`, not in a module variable: the server installs it from
 * its boot hook, and route bundles are separate module graphs that would not
 * see a module-level one.
 */
const RESOLVER_KEY = '__intentNetworkResolver'
const globals = globalThis as unknown as Record<string, Resolver | undefined>

/** Server only: how to find the network of the request that is running. */
export function setNetworkResolver(next: Resolver | undefined): void {
  globals[RESOLVER_KEY] = next
}

let clientNetwork: StellarNetworkName | undefined

/**
 * Browser only: the network of the page, set from its URL. Never called on
 * the server, where renders overlap and a shared variable would leak between
 * requests.
 */
export function setClientNetwork(next: StellarNetworkName | undefined): void {
  clientNetwork = next
}

export function activeNetwork(): StellarNetworkName {
  const fallback = defaultNetwork()
  if (!isMultiNetwork()) return fallback
  if (typeof window !== 'undefined') return clientNetwork ?? fallback

  const resolved = globals[RESOLVER_KEY]?.()
  if (resolved === undefined) {
    throw new Error(
      'No Stellar network is selected for this call. This deployment serves several, ' +
        'so work outside a request has to name its network (runWithNetwork).'
    )
  }
  return resolved
}

export function isMainnet(): boolean {
  return activeNetwork() === 'mainnet'
}
