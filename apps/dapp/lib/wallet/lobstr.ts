/** Where the LOBSTR extension's API keeps this tab's connection key. */
export const LOBSTR_CONNECTION_KEY = 'LOBSTR_CONNECTION_KEY'

/**
 * Whether LOBSTR must be asked for access before it can sign in this tab.
 *
 * LOBSTR signs only with a connection key, which its API writes to
 * `sessionStorage` when access is granted. sessionStorage belongs to one tab,
 * while the app restores a wallet from localStorage, so in a new tab or after
 * a restart the wallet reads as connected and every signature fails with
 * "The connection key is missing".
 */
export function lobstrNeedsConnection(
  walletId: string | undefined,
  session: Pick<Storage, 'getItem'> | undefined
): boolean {
  if (walletId !== 'lobstr') return false
  if (session === undefined) return true
  const key = session.getItem(LOBSTR_CONNECTION_KEY)
  return key === null || key === ''
}
