import { StrKey } from '@stellar/stellar-sdk'

import { NameLookupFailed, NameNotFound } from './errors'
import { isFederationAddress } from './kind'

/**
 * SEP-2 federation: `name*domain` to an account, through the domain's own
 * server.
 *
 * Two fetches, and the second is only as trustworthy as the first. The
 * domain's `stellar.toml` names the federation server; the server answers
 * for the name. Nothing here pins a key the way the offramp's toml reader
 * does, because federation has none to pin — the answer is the domain's word,
 * over TLS, which is exactly what the user asked for when they typed the
 * domain. What this refuses is anything less than that: a server that is not
 * https, an account id that is not a key, a memo type outside the three the
 * network has.
 *
 * The memo matters more than it looks. An exchange's federation answer is a
 * pooled account plus a memo saying whose deposit this is; a payment that
 * drops the memo lands in the pool and is nobody's. So the memo travels with
 * the address from here, and the payment builder refuses to omit it.
 *
 * **The server fetches whatever domain was typed**, which is a capability the
 * offramp never had — its toml reader reaches only pinned anchors. So both
 * fetches are bounded in time, never follow a redirect, never reach a
 * loopback, private or unqualified host, and report nothing about the
 * upstream beyond that it did not answer. Without that, typing a name is a
 * way to make this server probe hosts it can reach and the caller cannot.
 */

const FEDERATION_SERVER = /^\s*FEDERATION_SERVER\s*=\s*"([^"]*)"/m
const FETCH_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024
/** Suffixes that name something inside a network rather than on the internet. */
const RESERVED_HOST = /(?:^|\.)(?:localhost|local|internal|home\.arpa|lan|test|invalid|onion)$/i

export type FederationMemoType = 'text' | 'id' | 'hash'
const MEMO_TYPES = new Set<string>(['text', 'id', 'hash'])

export interface ResolveFederationOptions {
  fetchImpl?: typeof fetch
}

export interface FederationAnswer {
  address: string
  memo?: string
  memoType?: FederationMemoType
}

/** A hostname on the public internet, by shape: qualified, named, not reserved. */
function isPublicHost(hostname: string): boolean {
  if (!hostname.includes('.')) return false
  if (/^[\d.]+$/.test(hostname)) return false
  if (hostname.includes(':') || hostname.startsWith('[')) return false
  return !RESERVED_HOST.test(hostname)
}

function guarded(init: RequestInit = {}): RequestInit {
  return { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
}

function tooLarge(res: Response): boolean {
  const length = Number(res.headers.get('content-length') ?? '0')
  return Number.isFinite(length) && length > MAX_BODY_BYTES
}

async function federationServerOf(domain: string, fetchImpl: typeof fetch): Promise<URL> {
  let res: Response
  try {
    res = await fetchImpl(`https://${domain}/.well-known/stellar.toml`, guarded())
  } catch {
    throw new NameLookupFailed(`${domain} could not be reached`)
  }
  if (!res.ok || tooLarge(res)) {
    throw new NameLookupFailed(`${domain} did not serve a stellar.toml`)
  }

  const server = FEDERATION_SERVER.exec((await res.text()).slice(0, MAX_BODY_BYTES))?.[1]?.trim()
  if (server === undefined || server === '') {
    throw new NameLookupFailed(`${domain} publishes no federation server`)
  }

  let url: URL
  try {
    url = new URL(server)
  } catch {
    throw new NameLookupFailed(`${domain} names a federation server that is not a URL`)
  }
  if (url.protocol !== 'https:') {
    throw new NameLookupFailed(`${domain} names a federation server that is not https`)
  }
  if (!isPublicHost(url.hostname)) {
    throw new NameLookupFailed(`${domain} names a federation server this app will not reach`)
  }
  return url
}

export async function resolveFederation(
  address: string,
  options: ResolveFederationOptions = {}
): Promise<FederationAnswer> {
  const fetchImpl = options.fetchImpl ?? fetch
  const trimmed = address.trim()
  if (!isFederationAddress(trimmed)) {
    throw new NameLookupFailed(`${address} is not a federation address`)
  }
  const domain = trimmed.slice(trimmed.indexOf('*') + 1).toLowerCase()
  if (!isPublicHost(domain)) {
    throw new NameLookupFailed(`${domain} is not a domain this app will reach`)
  }

  const query = await federationServerOf(domain, fetchImpl)
  query.searchParams.set('q', trimmed)
  query.searchParams.set('type', 'name')

  let res: Response
  try {
    res = await fetchImpl(query.toString(), guarded({ headers: { Accept: 'application/json' } }))
  } catch {
    throw new NameLookupFailed(`the federation server for ${domain} could not be reached`)
  }
  if (res.status === 404) throw new NameNotFound(`${trimmed} is not known to ${domain}`)
  if (!res.ok || tooLarge(res)) {
    throw new NameLookupFailed(`the federation server for ${domain} did not answer`)
  }

  let body: { account_id?: unknown; memo_type?: unknown; memo?: unknown }
  try {
    body = JSON.parse((await res.text()).slice(0, MAX_BODY_BYTES)) as typeof body
  } catch {
    throw new NameLookupFailed(`the federation server for ${domain} did not answer with JSON`)
  }

  if (typeof body.account_id !== 'string' || !StrKey.isValidEd25519PublicKey(body.account_id)) {
    throw new NameLookupFailed(`${domain} named an account that is not a public key`)
  }

  if (body.memo_type === undefined || body.memo_type === null) {
    return { address: body.account_id }
  }
  if (typeof body.memo_type !== 'string' || !MEMO_TYPES.has(body.memo_type)) {
    throw new NameLookupFailed(
      `${domain} named a memo type this app cannot send: ${String(body.memo_type)}`
    )
  }
  // A string, as SEP-2 says. A number would pass through JavaScript's float
  // and, past 2^53, land on a different sub-account without any error.
  if (typeof body.memo !== 'string') {
    throw new NameLookupFailed(`${domain} named a memo type but no memo`)
  }

  return {
    address: body.account_id,
    memo: body.memo,
    memoType: body.memo_type as FederationMemoType,
  }
}
