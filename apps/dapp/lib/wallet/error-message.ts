const FALLBACK = 'The wallet could not sign this.'

/**
 * The words a wallet gave for a failure, whatever shape it threw them in.
 *
 * The LOBSTR extension throws its error text as a plain string, and the wallet
 * kit rethrows errors as `{ code, message }`. Reading only `Error.message` hid
 * every one of those behind a generic "could not sign".
 */
export function walletErrorMessage(e: unknown): string {
  if (typeof e === 'string') return e.trim() || FALLBACK
  if (e instanceof Error) return e.message.trim() || FALLBACK
  if (typeof e === 'object' && e !== null) {
    for (const key of ['message', 'error'] as const) {
      const value = (e as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return FALLBACK
}
