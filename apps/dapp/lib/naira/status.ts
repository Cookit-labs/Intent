/**
 * What the user sees of a payout, from the provider's free-text statuses.
 *
 * The provider's strings are not an enum ("processing: in bank queue",
 * "timeout: no deposit received"), and its name is not the user's to read.
 * Anything not recognised is `processing`: a payout in an unknown state is more
 * likely under way than failed, and "failed" would invite a second payment.
 */
export type NairaStatus = 'waiting' | 'processing' | 'paid' | 'expired' | 'failed'

export function normaliseStatus(provider: string): NairaStatus {
  const s = provider.trim().toLowerCase()
  if (s === 'initiated') return 'waiting'
  if (s.startsWith('timeout')) return 'expired'
  if (s === 'disbursed' || s.startsWith('settled')) return 'paid'
  if (s === 'failed' || s.startsWith('failed')) return 'failed'
  return 'processing'
}

/** A status that can no longer change. */
export function isTerminal(status: NairaStatus): boolean {
  return status === 'paid' || status === 'expired' || status === 'failed'
}
