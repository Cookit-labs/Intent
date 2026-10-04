/**
 * Whether a SEP-10 token was issued to `account`.
 *
 * The token is a JWT whose `sub` is the account, or `account:memo` for a
 * memo-scoped session. It is decoded and not verified: the anchor is the
 * party that verifies it, and answers only for the withdrawals it owns. What
 * this guards is attribution — a page holding someone else's token and
 * withdrawal id must not get this user to pay for it.
 */
export function tokenBelongsTo(token: string, account: string): boolean {
  const payload = token.split('.')[1]
  if (token.split('.').length !== 3 || payload === undefined) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown
    }
    if (typeof claims.sub !== 'string') return false
    return claims.sub === account || claims.sub.startsWith(`${account}:`)
  } catch {
    return false
  }
}
