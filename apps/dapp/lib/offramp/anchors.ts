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
  },
  moneygram: {
    id: 'moneygram',
    name: 'MoneyGram Access (testnet)',
    homeDomain: 'extstellar.moneygram.com',
    signingKey: 'GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4',
    assets: ['USDC'],
    what: 'Cash pickup at MoneyGram locations. This is the test deployment.',
    requiresClientDomain: true,
  },
}

export const ALL_ANCHORS: readonly AnchorId[] = ['testanchor', 'moneygram']

/** Where "send it to my bank" goes when no anchor is named. */
export const DEFAULT_ANCHOR: AnchorId = 'testanchor'

export function isAnchorId(value: string): value is AnchorId {
  return Object.prototype.hasOwnProperty.call(ANCHORS, value)
}

export function lookupAnchor(id: string): AnchorEntry | undefined {
  return isAnchorId(id) ? ANCHORS[id] : undefined
}
