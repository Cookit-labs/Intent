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
 */

const FEDERATION_SERVER = /^\s*FEDERATION_SERVER\s*=\s*"([^"]*)"/m

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

async function federationServerOf(domain: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`https://${domain}/.well-known/stellar.toml`)
  } catch (e) {
    throw new NameLookupFailed(
      `${domain} could not be reached: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!res.ok) {
    throw new NameLookupFailed(`${domain} answered ${res.status} for its stellar.toml`)
  }

  const server = FEDERATION_SERVER.exec(await res.text())?.[1]?.trim()
  if (server === undefined || server === '') {
    throw new NameLookupFailed(`${domain} publishes no federation server`)
  }
  if (!server.startsWith('https://')) {
    throw new NameLookupFailed(`${domain} names a federation server that is not https`)
  }
  return server
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

  const server = await federationServerOf(domain, fetchImpl)

  let res: Response
  try {
    res = await fetchImpl(`${server}?q=${encodeURIComponent(trimmed)}&type=name`, {
      headers: { Accept: 'application/json' },
    })
  } catch (e) {
    throw new NameLookupFailed(
      `the federation server for ${domain} could not be reached: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (res.status === 404) throw new NameNotFound(`${trimmed} is not known to ${domain}`)
  if (!res.ok) {
    throw new NameLookupFailed(`the federation server for ${domain} answered ${res.status}`)
  }

  let body: { account_id?: unknown; memo_type?: unknown; memo?: unknown }
  try {
    body = (await res.json()) as typeof body
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
  if (body.memo === undefined || body.memo === null) {
    throw new NameLookupFailed(`${domain} named a memo type but no memo`)
  }

  return {
    address: body.account_id,
    memo: String(body.memo),
    memoType: body.memo_type as FederationMemoType,
  }
}
