import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit'
import { stellarTestnet } from '@intent/config'

import { apiRequest } from './http-client'

/**
 * Exchanging a wallet signature for a backend session.
 *
 * The dapp has always asked the wallet to sign a login message and then thrown
 * the signature away — the session was written to localStorage and "signed in"
 * meant "the browser says so". The backend, meanwhile, scoped every row by a
 * wallet address the caller simply asserted, so reading someone else's history
 * was a matter of typing their address.
 *
 * The two gaps close each other: the signature just has to reach the server.
 *
 * The challenge is now the server's, not the client's. The old message embedded
 * a timestamp the browser generated, which meant the client chose its own
 * freshness and one captured signature stayed usable for as long as the server
 * would accept it. A server nonce is single-use by construction.
 */

const TOKEN_KEY = 'intent.session.v1'

interface StoredToken {
  token: string
  address: string
  /** ISO. Checked before use so an expired token is not sent. */
  expiresAt: string
}

function read(): StoredToken | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(TOKEN_KEY)
    if (raw === null) return undefined
    return JSON.parse(raw) as StoredToken
  } catch {
    // Private-mode browsers throw on access. The session simply will not
    // survive a reload, which is a degradation rather than a failure.
    return undefined
  }
}

function write(value: StoredToken | undefined): void {
  if (typeof window === 'undefined') return
  try {
    if (value === undefined) window.localStorage.removeItem(TOKEN_KEY)
    else window.localStorage.setItem(TOKEN_KEY, JSON.stringify(value))
  } catch {
    /* see read() */
  }
}

/**
 * The current session token, if one is valid for this address.
 *
 * Returns nothing when the stored token belongs to a different wallet — a user
 * switching accounts in their wallet extension must not keep acting as the
 * previous one.
 */
export function currentToken(address?: string): string | undefined {
  const stored = read()
  if (stored === undefined) return undefined
  if (address !== undefined && stored.address !== address) return undefined

  // A minute of headroom: a token that expires mid-request reads as a
  // confusing auth failure rather than an expected re-login.
  if (Date.now() > new Date(stored.expiresAt).getTime() - 60_000) return undefined

  return stored.token
}

export function clearSession(): void {
  write(undefined)
}

interface NonceResponse {
  nonce: string
  /** The exact text to sign. Returned rather than rebuilt, so the two cannot drift. */
  message: string
}

interface VerifyResponse {
  token: string
  address: string
  expires_at: string
}

/**
 * Signs in, prompting the wallet once.
 *
 * Returns the token. Throws if the user declines, which is an ordinary outcome
 * and should be reported as such rather than as an error state.
 */
export async function signIn(address: string): Promise<string> {
  const challenge = await apiRequest<NonceResponse>('/auth/nonce', {
    method: 'POST',
    body: { address, chain: 'stellar' },
  })

  const signed = await StellarWalletsKit.signMessage(challenge.message, {
    address,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })

  if (signed.signedMessage === null || signed.signedMessage === undefined) {
    throw new Error('Signature declined.')
  }

  const session = await apiRequest<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: {
      address,
      nonce: challenge.nonce,
      signature: signed.signedMessage,
    },
  })

  write({ token: session.token, address: session.address, expiresAt: session.expires_at })
  return session.token
}

/**
 * A token for this address, signing in only if there is not one already.
 *
 * Callers use this rather than `signIn` so a valid session does not prompt the
 * wallet on every request.
 */
export async function ensureSession(address: string): Promise<string> {
  return currentToken(address) ?? (await signIn(address))
}
