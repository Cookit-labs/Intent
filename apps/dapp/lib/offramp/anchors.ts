import { activeNetwork, type StellarNetworkName } from '@intent/config'

/**
 * Which anchors this app will send funds to, and what each must prove.
 *
 * An offramp is the one operation in this app that pays a third party, so the
 * third party is an allowlist — the same discipline `contract-registry.ts`
 * applies to Soroban calls. Each entry pins the anchor's SEP-10 signing key.
 * At runtime the TOML is fetched and compared to the pin; a mismatch refuses
 * the anchor rather than trusting whatever the network returned. Rotating a
 * key is a deliberate code change.
 *
 * Both entries were verified reachable on 2026-09-18: TOML fetched, `/info`
 * read, `/auth` returned a challenge. `anchor-sep24.stellar.org`, cited in
 * older material, does not resolve and is deliberately absent.
 */

export type AnchorId = 'testanchor' | 'moneygram'

export interface AnchorEntry {
  id: AnchorId
  /** Shown on the confirmation screen and in history. */
  name: string
  /** Where `/.well-known/stellar.toml` is fetched from. */
  homeDomain: string
  /** The SEP-10 signing key the TOML must match. */
  signingKey: string
  /** Asset codes this anchor withdraws. USDC only, today. */
  assets: string[]
  /** One line for the review card about what the fiat side looks like. */
  what: string
  /**
   * Whether the anchor's SEP-10 challenge requires a `client_domain`.
   *
   * MoneyGram's does: the wallet must be reachable at a domain that serves
   * its own stellar.toml with a SIGNING_KEY, and the wallet's server must
   * co-sign every challenge with that key. Measured live on 2026-09-21 —
   * `/auth` answers `client_domain is required` before issuing a challenge.
   * This deployment has no such domain, so an anchor flagged here is refused
   * with that reason rather than attempted.
   */
  requiresClientDomain: boolean
  /** The networks this entry's home domain serves. */
  networks: StellarNetworkName[]
}

export const ANCHORS: Record<AnchorId, AnchorEntry> = {
  testanchor: {
    id: 'testanchor',
    name: 'SDF test anchor',
    homeDomain: 'testanchor.stellar.org',
    signingKey: 'GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR',
    assets: ['USDC'],
    what: 'A reference anchor with a fake bank. Nothing real is paid out.',
    requiresClientDomain: false,
    networks: ['testnet'],
  },
  moneygram: {
    id: 'moneygram',
    name: 'MoneyGram Access (testnet)',
    homeDomain: 'extstellar.moneygram.com',
    signingKey: 'GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4',
    assets: ['USDC'],
    what: 'Cash pickup at MoneyGram locations. This is the test deployment.',
    requiresClientDomain: true,
    networks: ['testnet'],
  },
}

export const ALL_ANCHORS: readonly AnchorId[] = ['testanchor', 'moneygram']

/** Where "send it to my bank" goes when no anchor is named. */
export const DEFAULT_ANCHOR: AnchorId = 'testanchor'

export function isAnchorId(value: string): value is AnchorId {
  return Object.prototype.hasOwnProperty.call(ANCHORS, value)
}

/** The static entry by id, whatever the network: names and ids for display. */
export function lookupAnchor(id: string): AnchorEntry | undefined {
  return isAnchorId(id) ? ANCHORS[id] : undefined
}

type Env = Record<string, string | undefined>

/** Names MoneyGram's production home domain, and by doing so turns it on for mainnet. */
export const MONEYGRAM_PRODUCTION_DOMAIN_ENV = 'MONEYGRAM_PRODUCTION_HOME_DOMAIN'

/**
 * MoneyGram's production signing key, pinned from
 * https://stellar.moneygram.com/.well-known/stellar.toml on 2026-09-24
 * exactly as the testnet keys above were. The domain is not pinned: the
 * operator names it once the commercial agreement exists, and a domain whose
 * TOML does not carry this key is refused like any other mismatch.
 */
const MONEYGRAM_PRODUCTION_SIGNING_KEY = 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL'

function moneygramProduction(env: Env): AnchorEntry | undefined {
  const domain = env[MONEYGRAM_PRODUCTION_DOMAIN_ENV]?.trim()
  if (domain === undefined || domain === '') return undefined
  return {
    id: 'moneygram',
    name: 'MoneyGram Access',
    homeDomain: domain,
    signingKey: MONEYGRAM_PRODUCTION_SIGNING_KEY,
    assets: ['USDC'],
    what: 'Cash pickup at MoneyGram locations.',
    requiresClientDomain: true,
    networks: ['mainnet'],
  }
}

/**
 * The anchor's entry on a network, or nothing when it has none there.
 *
 * The test anchor and MoneyGram's test deployment are testnet by definition.
 * MoneyGram's production deployment exists here only once an operator names
 * its domain — a commercial agreement stands between this app and it, and
 * the app must not pretend otherwise.
 */
export function anchorOn(
  id: AnchorId,
  network: StellarNetworkName = activeNetwork(),
  env: Env = process.env
): AnchorEntry | undefined {
  const entry = ANCHORS[id]
  if (entry.networks.includes(network)) return entry
  if (id === 'moneygram' && network === 'mainnet') return moneygramProduction(env)
  return undefined
}

/** The anchors with an entry on the network, in `ALL_ANCHORS` order. */
export function anchorsOn(
  network: StellarNetworkName = activeNetwork(),
  env: Env = process.env
): AnchorId[] {
  return ALL_ANCHORS.filter((id) => anchorOn(id, network, env) !== undefined)
}

export const NO_MAINNET_OFFRAMP = 'no fiat off-ramp is configured on mainnet yet'

/**
 * The entry to send funds to on this network, or the reason there is none.
 *
 * Worded for the person reading it: with nothing configured on mainnet the
 * useful fact is that there is no off-ramp at all, not which anchor they
 * happened to name.
 */
export function resolveAnchor(
  id: string,
  network: StellarNetworkName = activeNetwork(),
  env: Env = process.env
): { ok: true; anchor: AnchorEntry } | { ok: false; reason: string } {
  if (!isAnchorId(id)) return { ok: false, reason: `${id} is not an anchor this app uses` }
  const anchor = anchorOn(id, network, env)
  if (anchor !== undefined) return { ok: true, anchor }
  if (network === 'mainnet' && anchorsOn(network, env).length === 0) {
    return { ok: false, reason: NO_MAINNET_OFFRAMP }
  }
  return { ok: false, reason: `${ANCHORS[id].name} is not on ${network}` }
}

/** Why an anchor cannot be used on this network, or nothing when it can. */
export function anchorUnavailableReason(
  id: string,
  network: StellarNetworkName = activeNetwork(),
  env: Env = process.env
): string | undefined {
  const resolved = resolveAnchor(id, network, env)
  return resolved.ok ? undefined : resolved.reason
}
