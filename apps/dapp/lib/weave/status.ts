export type WeaveStatus = 'waiting' | 'processing' | 'paid' | 'failed' | 'expired' | 'refunded'

const FROM_PROVIDER: Readonly<Record<string, WeaveStatus>> = {
  awaiting_deposit: 'waiting',
  processing: 'processing',
  completed: 'paid',
  failed: 'failed',
  expired: 'expired',
  // The docs disagree on whether this state exists, so it is read if it arrives.
  refunded: 'refunded',
}

/** What a provider status means here, or nothing for a string that is not known. */
export function mapProviderStatus(provider: string): WeaveStatus | undefined {
  const key = provider.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(FROM_PROVIDER, key) ? FROM_PROVIDER[key] : undefined
}

/** A status that can no longer change. */
export function isFinal(status: WeaveStatus): boolean {
  return status === 'paid' || status === 'failed' || status === 'expired' || status === 'refunded'
}

/**
 * Where an order goes from here. An unknown string changes nothing, and neither
 * does a late event about an order that has ended. An order never returns to
 * `waiting`: that is the only status a deposit can be built for, so an
 * out-of-date answer about a funded order must not invite a second payment.
 */
export function nextStatus(current: WeaveStatus, provider: string): WeaveStatus {
  if (isFinal(current)) return current
  const mapped = mapProviderStatus(provider)
  if (mapped === undefined) return current
  if (mapped === 'waiting' && current !== 'waiting') return current
  return mapped
}
