import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

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

/** Every address a host resolves to. */
export type HostLookup = (hostname: string) => Promise<string[]>

export interface ResolveFederationOptions {
  fetchImpl?: typeof fetch
  /**
   * Resolves a host before it is fetched, so a public name that points at a
   * private address is refused. Defaults to the system resolver, except when
   * `fetchImpl` is injected: a caller that supplies its own network has no
   * real hosts to resolve.
   */
  lookup?: HostLookup
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

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/** Loopback, private, link-local, unspecified or reserved, in either IP family. */
function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateV4(address)
  if (family !== 6) return true
  const v6 = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1])
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

async function assertResolvesPublic(hostname: string, lookup: HostLookup): Promise<void> {
  let addresses: string[]
  try {
    addresses = await lookup(hostname)
  } catch {
    throw new NameLookupFailed(`${hostname} could not be reached`)
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new NameLookupFailed(`${hostname} is not a host this app will reach`)
  }
}

function defaultLookup(options: ResolveFederationOptions): HostLookup | undefined {
  if (options.lookup !== undefined) return options.lookup
  if (options.fetchImpl !== undefined) return undefined
  return async (hostname) => (await dnsLookup(hostname, { all: true })).map((r) => r.address)
}

function guarded(init: RequestInit = {}): RequestInit {
  return { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
}

function tooLarge(res: Response): boolean {
  const length = Number(res.headers.get('content-length') ?? '0')
  return Number.isFinite(length) && length > MAX_BODY_BYTES
}

/**
 * The body as text, refused once it passes the cap. `content-length` is the
 * sender's claim; a chunked response has none, so the stream is counted.
 */
async function readBounded(res: Response): Promise<string | undefined> {
  if (tooLarge(res)) return undefined
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function federationServerOf(
  domain: string,
  fetchImpl: typeof fetch,
  lookup: HostLookup | undefined
): Promise<URL> {
  if (lookup !== undefined) await assertResolvesPublic(domain, lookup)
  let res: Response
  try {
    res = await fetchImpl(`https://${domain}/.well-known/stellar.toml`, guarded())
  } catch {
    throw new NameLookupFailed(`${domain} could not be reached`)
  }
  const toml = res.ok ? await readBounded(res) : undefined
  if (toml === undefined) {
    throw new NameLookupFailed(`${domain} did not serve a stellar.toml`)
  }

  const server = FEDERATION_SERVER.exec(toml)?.[1]?.trim()
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
  if (lookup !== undefined) await assertResolvesPublic(url.hostname, lookup)
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

  const query = await federationServerOf(domain, fetchImpl, defaultLookup(options))
  query.searchParams.set('q', trimmed)
  query.searchParams.set('type', 'name')

  let res: Response
  try {
    res = await fetchImpl(query.toString(), guarded({ headers: { Accept: 'application/json' } }))
  } catch {
    throw new NameLookupFailed(`the federation server for ${domain} could not be reached`)
  }
  if (res.status === 404) throw new NameNotFound(`${trimmed} is not known to ${domain}`)
  const text = res.ok ? await readBounded(res) : undefined
  if (text === undefined) {
    throw new NameLookupFailed(`the federation server for ${domain} did not answer`)
  }

  let body: { account_id?: unknown; memo_type?: unknown; memo?: unknown }
  try {
    body = JSON.parse(text) as typeof body
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
