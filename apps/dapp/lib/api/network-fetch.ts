import { NETWORK_HEADER, type StellarNetworkName } from '@intent/config'

import { WALLET_HEADER } from '../wallet-header'

export const RACE_HEADER = 'x-intent-race'

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
let connectedWallet: string | undefined

/** The wallet connected on this page, sent so the server can tell wallets apart while sign-in is paused. */
export function setConnectedWallet(address: string | undefined): void {
  connectedWallet = address
}

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
    if (connectedWallet !== undefined) headers.set(WALLET_HEADER, connectedWallet)
    // A chain submit names its own race (see submitSigned), so a race left over from earlier
    // can never be put on an action that did not come from it.
    if (raceInFlight !== undefined && path.endsWith('/submit') && !path.startsWith('/api/chain/')) {
      headers.set(RACE_HEADER, raceInFlight)
    }
    return base(input, { ...init, headers })
  }
}

/**
 * For calls that need the requester named on every deployment. `networkFetch` is
 * only installed where several networks are served, so a single-network page would
 * otherwise send no wallet at all.
 */
export function walletFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (connectedWallet !== undefined) headers.set(WALLET_HEADER, connectedWallet)
  return fetch(input, { ...init, headers })
}

const BASE_KEY = '__intentBaseFetch'

/**
 * Every page's own API calls carry the connected wallet, whatever the deployment serves.
 *
 * Installing only where several networks are served left a one-network deployment
 * sending no wallet at all: with sign-in paused, every route that keys records by
 * wallet answered "connect your wallet" to a connected one, and showed no history.
 */
export function installPageFetch(network: StellarNetworkName): void {
  installNetworkFetch(network)
}

/** Browser only. Safe to call again with another network; it wraps the original, never the wrapper. */
export function installNetworkFetch(network: StellarNetworkName): void {
  if (typeof window === 'undefined') return
  const holder = window as unknown as Record<string, typeof fetch | undefined>
  const base = holder[BASE_KEY] ?? window.fetch.bind(window)
  holder[BASE_KEY] = base
  window.fetch = networkFetch(base, network, window.location.origin)
}
