import { NETWORK_HEADER, type StellarNetworkName } from '@intent/config'

const RACE_HEADER = 'x-intent-race'

/**
 * Tells the server which Stellar network a page is on.
 *
 * Server code learns the network of a request from a header middleware reads.
 * The browser's own calls to this app's API carry it here, taken from the page
 * they were made on, so each tab keeps its own network and a call can never
 * answer for a different one than the screen that made it.
 */

function ownApiPath(input: RequestInfo | URL, origin: string): string | undefined {
  const raw = input instanceof Request ? input.url : String(input)
  try {
    const url = new URL(raw, origin)
    return url.origin === origin && url.pathname.startsWith('/api/') ? url.pathname : undefined
  } catch {
    return undefined
  }
}

let raceInFlight: string | undefined

/** The race whose plan the user is about to sign; sent with submits so the log can credit the agent. */
export function setAttributedRace(id: string | undefined): void {
  raceInFlight = id
}

/** A `fetch` that adds the network header to this app's own API calls and touches nothing else. */
export function networkFetch(
  base: typeof fetch,
  network: StellarNetworkName,
  origin: string
): typeof fetch {
  return (input, init) => {
    const path = ownApiPath(input, origin)
    if (path === undefined) return base(input, init)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set(NETWORK_HEADER, network)
    if (raceInFlight !== undefined && path.endsWith('/submit')) {
      headers.set(RACE_HEADER, raceInFlight)
    }
    return base(input, { ...init, headers })
  }
}

const BASE_KEY = '__intentBaseFetch'

/** Browser only. Safe to call again with another network; it wraps the original, never the wrapper. */
export function installNetworkFetch(network: StellarNetworkName): void {
  if (typeof window === 'undefined') return
  const holder = window as unknown as Record<string, typeof fetch | undefined>
  const base = holder[BASE_KEY] ?? window.fetch.bind(window)
  holder[BASE_KEY] = base
  window.fetch = networkFetch(base, network, window.location.origin)
}
