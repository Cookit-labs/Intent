import { activeNetwork, stellarNetworkFor, type StellarNetworkName } from '@intent/config'

import { registerLiveAsset, resolveVerifiedAsset, type VerifiedAsset } from './asset-registry'

/**
 * Tokens beyond the hand-written allowlist, admitted only after they prove who
 * issued them.
 *
 * Soroswap publishes a public token list. A list is a convenience, not proof:
 * anyone can propose an entry, and the list itself carries two different "XRP"
 * tokens. So a listed token is a *candidate*. It becomes tradeable only when
 * its issuer passes the same round trip the allowlist demands: the issuing
 * account's `home_domain` names a site, and that site's `stellar.toml` names
 * the same account and code back. One direction proves nothing, because anyone
 * can point a home_domain at a domain they do not own.
 *
 * Mainnet only. The list is a mainnet list, and testnet is where squatted
 * tickers live.
 *
 * A ticker listed more than once, or verified under more than one issuer, is
 * refused outright: two real-looking answers to one name is the impersonation
 * case, and picking one would be a guess made with the user's money.
 */

const LIST_URL = 'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'
const LIST_TTL_MS = 60 * 60_000
const VERDICT_TTL_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 4_000
const MAX_CANDIDATES = 6

export interface ListedToken {
  code: string
  issuer: string
  name?: string
  domain?: string
  decimals?: number
}

interface Verdict {
  at: number
  asset: VerifiedAsset | null
}

let listed: { at: number; tokens: ListedToken[] } | undefined
const verdicts = new Map<string, Verdict>()

/** For tests: forgets the list and every verdict. */
export function resetLiveAssets(): void {
  listed = undefined
  verdicts.clear()
}

async function getJson(url: string, doFetch: typeof fetch): Promise<unknown> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.json()
}

async function getText(url: string, doFetch: typeof fetch): Promise<string> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.text()
}

/** The list's entries that are classic assets with an issuer; anything else is skipped. */
export async function fetchTokenList(
  doFetch: typeof fetch = fetch,
  now: number = Date.now()
): Promise<ListedToken[]> {
  if (listed !== undefined && now - listed.at < LIST_TTL_MS) return listed.tokens

  const body = (await getJson(LIST_URL, doFetch)) as { assets?: unknown }
  const tokens: ListedToken[] = []
  if (Array.isArray(body.assets)) {
    for (const raw of body.assets as Record<string, unknown>[]) {
      const code = raw['code']
      const issuer = raw['issuer']
      if (typeof code !== 'string' || typeof issuer !== 'string') continue
      if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !/^G[A-Z2-7]{55}$/.test(issuer)) continue
      tokens.push({
        code,
        issuer,
        ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
        ...(typeof raw['domain'] === 'string' ? { domain: raw['domain'] } : {}),
        ...(typeof raw['decimals'] === 'number' ? { decimals: raw['decimals'] } : {}),
      })
    }
  }
  listed = { at: now, tokens }
  return tokens
}

/**
 * Whether an issuer and a domain name each other for a code.
 *
 * The domain is read from the issuing account itself, never from the list.
 * Returns the domain on success.
 */
export async function verifyIssuer(
  code: string,
  issuer: string,
  horizonUrl: string,
  doFetch: typeof fetch = fetch
): Promise<string | null> {
  try {
    const account = (await getJson(
      `${horizonUrl.replace(/\/$/, '')}/accounts/${issuer}`,
      doFetch
    )) as { home_domain?: unknown }
    const domain = account.home_domain
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null

    const toml = await getText(`https://${domain}/.well-known/stellar.toml`, doFetch)
    return tomlNames(toml, code, issuer) ? domain : null
  } catch {
    return null
  }
}

/** True when a `[[CURRENCIES]]` block of the file carries both this code and this issuer. */
export function tomlNames(toml: string, code: string, issuer: string): boolean {
  const blocks = toml.split(/^\s*\[\[CURRENCIES\]\]\s*$/m).slice(1)
  const value = (block: string, key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block)
    return m?.[1]
  }
  return blocks.some((block) => {
    const next = block.search(/^\s*\[/m)
    const body = next === -1 ? block : block.slice(0, next)
    return value(body, 'code') === code && value(body, 'issuer') === issuer
  })
}

function asVerified(token: ListedToken, domain: string): VerifiedAsset {
  return {
    code: token.code,
    issuer: token.issuer,
    category: 'token',
    homeDomain: domain,
    trust: 'round-trip',
    description: `${token.name ?? token.code}, issued by ${domain}`,
    decimals: 7,
    tradeableOnTestnet: false,
    tradeableOnMainnet: true,
    networks: ['mainnet'],
  }
}

/**
 * Makes any of these tickers tradeable that are listed and prove their issuer.
 *
 * Quietly does nothing for anything already known, anything unlisted, anything
 * that fails verification, and everything off mainnet. A verdict, good or bad,
 * is remembered for hours, so a repeated name costs nothing.
 */
export async function ensureLiveAssets(
  candidates: unknown[],
  options: { fetchImpl?: typeof fetch; network?: StellarNetworkName; now?: number } = {}
): Promise<void> {
  const network = options.network ?? activeNetwork()
  if (network !== 'mainnet') return
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now()

  const named = [
    ...new Set(
      candidates
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z0-9]{2,12}$/.test(c) && resolveVerifiedAsset(c) === undefined)
    ),
  ]
  if (named.length === 0) return

  let tokens: ListedToken[]
  try {
    tokens = await fetchTokenList(doFetch, now)
  } catch {
    return
  }
  // Only names the list actually carries are worth a lookup; the rest of a
  // sentence is ordinary words.
  const listedCodes = new Set(tokens.map((t) => t.code.toUpperCase()))
  const wanted = named.filter((c) => listedCodes.has(c)).slice(0, MAX_CANDIDATES)
  if (wanted.length === 0) return
  const horizonUrl = stellarNetworkFor(network).horizonUrl

  await Promise.all(
    wanted.map(async (symbol) => {
      const held = verdicts.get(symbol)
      if (held !== undefined && now - held.at < VERDICT_TTL_MS) {
        if (held.asset !== null) registerLiveAsset(network, held.asset)
        return
      }

      const matches = tokens.filter((t) => t.code.toUpperCase() === symbol)
      let admitted: VerifiedAsset | null = null
      if (matches.length > 0) {
        const proofs = await Promise.all(
          matches.map(async (t) => ({
            token: t,
            domain: await verifyIssuer(t.code, t.issuer, horizonUrl, doFetch),
          }))
        )
        const proven = proofs.filter((p) => p.domain !== null)
        // Exactly one issuer may answer to the name.
        if (proven.length === 1 && matches.length === 1) {
          const [only] = proven
          if (only !== undefined && only.domain !== null) {
            admitted = asVerified(only.token, only.domain)
          }
        }
      }

      verdicts.set(symbol, { at: now, asset: admitted })
      if (admitted !== null) registerLiveAsset(network, admitted)
    })
  )
}

/** Every plausible ticker in a sentence, for deciding which names to look up. */
export function tickersIn(text: string): string[] {
  return text.match(/\b[A-Za-z][A-Za-z0-9]{1,11}\b/g) ?? []
}
