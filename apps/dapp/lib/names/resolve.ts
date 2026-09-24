import { StrKey } from '@stellar/stellar-sdk'

import { UnsupportedRecipient } from './errors'
import { isFederationAddress, resolveFederation } from './federation'
import type { FederationAnswer } from './federation'
import { isSorobanDomain, resolveSorobanDomain } from './soroban-domains'

/**
 * A recipient, however it was written, as one account to pay.
 *
 * Three forms and one answer. The form decides which lookup runs; the answer
 * carries where it came from, because the card owes the user that: a `.xlm`
 * name was answered by a registry on mainnet, and a federation address by
 * whatever server the domain publishes. A raw key was answered by nobody, and
 * says so by carrying no `resolvedOn`.
 *
 * **Only an account can be paid.** A contract (`C…`) or a muxed account
 * (`M…`) is a valid address a classic `payment` cannot reach, and a name may
 * resolve to either. Both are refused here by name rather than left to fail
 * at submission with a code that names nothing.
 */

export interface ResolvedRecipient {
  /** As typed, trimmed. */
  input: string
  kind: 'address' | 'soroban-domain' | 'federation'
  address: string
  memo?: string
  memoType?: 'text' | 'id' | 'hash'
  /** Where the answer came from, for the card. */
  resolvedOn?: 'stellar-mainnet' | 'federation'
}

/**
 * Which form the input takes, or nothing when it is none of them.
 *
 * A contract or muxed address counts as `address` here: the form is
 * recognisably an address, and the parser should read "send 5 XLM to C…" as
 * a payment so that the refusal can name the reason. The refusal itself is
 * `resolveRecipient`'s.
 */
export function recipientKind(input: string): ResolvedRecipient['kind'] | undefined {
  const trimmed = input.trim()
  if (
    StrKey.isValidEd25519PublicKey(trimmed) ||
    StrKey.isValidContract(trimmed) ||
    StrKey.isValidMed25519PublicKey(trimmed)
  ) {
    return 'address'
  }
  if (isSorobanDomain(trimmed)) return 'soroban-domain'
  if (isFederationAddress(trimmed)) return 'federation'
  return undefined
}

export interface ResolveRecipientOptions {
  /** Injected in tests. */
  resolveDomain?: (name: string) => Promise<{ address: string }>
  resolveFederation?: (address: string) => Promise<FederationAnswer>
}

function accountOnly(address: string, what: string): string {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new UnsupportedRecipient(
      `${what} is not an account address; only accounts (G…) can be paid here, not contracts or muxed accounts`
    )
  }
  return address
}

export async function resolveRecipient(
  input: string,
  options: ResolveRecipientOptions = {}
): Promise<ResolvedRecipient> {
  const trimmed = input.trim()
  const kind = recipientKind(trimmed)

  if (kind === undefined) {
    throw new UnsupportedRecipient(`${trimmed} is not an address or a name this app can resolve`)
  }

  if (kind === 'address') {
    return { input: trimmed, kind, address: accountOnly(trimmed, trimmed) }
  }

  if (kind === 'soroban-domain') {
    const name = trimmed.toLowerCase()
    const found = await (options.resolveDomain ?? resolveSorobanDomain)(name)
    return {
      input: trimmed,
      kind,
      address: accountOnly(found.address, `what ${name} points at`),
      resolvedOn: 'stellar-mainnet',
    }
  }

  const found = await (options.resolveFederation ?? resolveFederation)(trimmed)
  return {
    input: trimmed,
    kind,
    address: accountOnly(found.address, `what ${trimmed} points at`),
    ...(found.memo !== undefined && found.memoType !== undefined
      ? { memo: found.memo, memoType: found.memoType }
      : {}),
    resolvedOn: 'federation',
  }
}
