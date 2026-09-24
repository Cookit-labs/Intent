import { stellarNetwork } from '@intent/config'

import type { AnchorEntry } from './anchors'

/**
 * The anchor's `stellar.toml`, reduced to the four fields an offramp uses.
 *
 * A tiny parser rather than a TOML library: the file is flat `KEY = "value"`
 * lines for everything needed here, and the one dependency this would add is
 * not worth it for four keys. Sections (`[DOCUMENTATION]`, `[[CURRENCIES]]`)
 * and comments are skipped.
 *
 * **The signing key is compared to the pin, never taken from the file.** The
 * TOML is fetched over the network, and an attacker who could answer that
 * fetch could otherwise name their own key — after which every SEP-10
 * challenge they sign would verify. The pin in `anchors.ts` is the fact; the
 * TOML is checked against it.
 */

export interface AnchorToml {
  transferServerSep24: string
  webAuthEndpoint: string
  signingKey: string
  networkPassphrase: string
}

const KEYS: Record<string, keyof AnchorToml> = {
  TRANSFER_SERVER_SEP0024: 'transferServerSep24',
  WEB_AUTH_ENDPOINT: 'webAuthEndpoint',
  SIGNING_KEY: 'signingKey',
  NETWORK_PASSPHRASE: 'networkPassphrase',
}

export function parseStellarToml(text: string): Partial<AnchorToml> {
  const out: Partial<AnchorToml> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const field = KEYS[key]
    if (field === undefined) continue
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
    out[field] = value
  }
  return out
}

export function tomlUrl(anchor: AnchorEntry): string {
  return `https://${anchor.homeDomain}/.well-known/stellar.toml`
}

export async function readAnchorToml(
  anchor: AnchorEntry,
  fetchImpl: typeof fetch = fetch
): Promise<AnchorToml> {
  const res = await fetchImpl(tomlUrl(anchor))
  if (!res.ok) throw new Error(`refusing anchor ${anchor.id}: TOML returned ${res.status}`)

  const parsed = parseStellarToml(await res.text())

  if (parsed.signingKey !== anchor.signingKey) {
    throw new Error(
      `refusing anchor ${anchor.id}: its signing key ${parsed.signingKey ?? '(none)'} is not the pinned one`
    )
  }
  if (parsed.networkPassphrase !== stellarNetwork.networkPassphrase) {
    throw new Error(`refusing anchor ${anchor.id}: it is on another network`)
  }
  if (parsed.transferServerSep24 === undefined || parsed.transferServerSep24 === '') {
    throw new Error(`refusing anchor ${anchor.id}: no SEP-24 transfer server`)
  }
  if (parsed.webAuthEndpoint === undefined || parsed.webAuthEndpoint === '') {
    throw new Error(`refusing anchor ${anchor.id}: no SEP-10 auth endpoint`)
  }

  return {
    transferServerSep24: parsed.transferServerSep24.replace(/\/$/, ''),
    webAuthEndpoint: parsed.webAuthEndpoint,
    signingKey: parsed.signingKey,
    networkPassphrase: parsed.networkPassphrase,
  }
}
