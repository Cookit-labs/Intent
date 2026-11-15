/**
 * What the user sees of a payout, from the provider's free-text statuses.
 *
 * The provider's strings are not an enum ("processing: in bank queue",
 * "timeout: no deposit received"), and its name is not the user's to read.
 * Anything not recognised is `processing`: a payout in an unknown state is more
 * likely under way than failed, and "failed" would invite a second payment.
 * Only the one state known to precede the deposit is `waiting`; "in bank
 * queue" and anything unfamiliar are not, because paying into an order that
 * already has its deposit would be paying twice.
 */
export type NairaStatus = 'waiting' | 'processing' | 'paid' | 'expired' | 'failed'

export function normaliseStatus(provider: string, depositDigest?: string): NairaStatus {
  const s = provider.trim().toLowerCase()
  if (s === 'initiated') return 'waiting'
  // The provider's "processing: wallet worker on it.." means its worker is
  // watching the deposit wallet, which is before any deposit. Treating it as a
  // deposit received refused the payment the order was waiting for.
  if (s.startsWith('processing') && /wallet worker|watching/.test(s)) return 'waiting'
  // New orders read "processing: in order queue" from 15 November 2026. It counts as
  // waiting only beside a live read whose deposit digest is present and empty.
  if (s.startsWith('processing') && s.includes('order queue') && depositDigest === '') {
    return 'waiting'
  }
  if (s.startsWith('timeout')) return 'expired'
  if (s === 'disbursed' || s.startsWith('settled')) return 'paid'
  if (s === 'failed' || s.startsWith('failed')) return 'failed'
  return 'processing'
}

/** A status that can no longer change. */
export function isTerminal(status: NairaStatus): boolean {
  return status === 'paid' || status === 'expired' || status === 'failed'
}
