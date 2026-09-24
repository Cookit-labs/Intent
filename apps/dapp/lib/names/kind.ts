/**
 * Which form a recipient takes, by shape alone.
 *
 * Deliberately free of `@stellar/stellar-sdk`. The parser and the address
 * book run in the browser, where no module of this app imports the SDK —
 * reading a balance is one GET, and the SDK is a multi-megabyte dependency
 * that exists for building and signing. So an address is recognised here by
 * its shape, and its checksum is the server's to verify when it resolves the
 * recipient for real.
 */

export type RecipientKind = 'address' | 'soroban-domain' | 'federation'

const TLD = 'xlm'
/** The registry's own rule: lowercase letters, one to fifteen of them. */
const DOMAIN_LABEL = /^[a-z]{1,15}$/
/** `name*domain`, where the domain has at least one dot and a letters-only TLD. */
const FEDERATION_ADDRESS = /^[^*\s]+\*[a-z0-9.-]+\.[a-z]{2,}$/i
/** A `G…` account or `C…` contract is 56 base32 characters; a muxed `M…` account is 69. */
const ADDRESS_SHAPE = /^(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})$/

export function domainLabels(input: string): string[] {
  return input.trim().toLowerCase().split('.')
}

export function isSorobanDomain(input: string): boolean {
  const labels = domainLabels(input)
  if (labels.length < 2 || labels[labels.length - 1] !== TLD) return false
  return labels.slice(0, -1).every((label) => DOMAIN_LABEL.test(label))
}

export function isFederationAddress(input: string): boolean {
  return FEDERATION_ADDRESS.test(input.trim())
}

/**
 * Whether the input is shaped like any Stellar address.
 *
 * A contract or muxed address counts: the form is recognisably an address,
 * and the parser should read "send 5 XLM to C…" as a payment so that the
 * refusal can name the reason. The refusal itself is the resolver's.
 */
export function looksLikeAddress(input: string): boolean {
  return ADDRESS_SHAPE.test(input.trim())
}

export function recipientKind(input: string): RecipientKind | undefined {
  const trimmed = input.trim()
  if (looksLikeAddress(trimmed)) return 'address'
  if (isSorobanDomain(trimmed)) return 'soroban-domain'
  if (isFederationAddress(trimmed)) return 'federation'
  return undefined
}
