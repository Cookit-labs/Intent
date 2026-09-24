import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit'
import { stellarNetwork } from '@intent/config'

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

/** An ed25519 signature, in bytes. The server accepts nothing else. */
const SIGNATURE_BYTES = 64

/**
 * A wallet's signature, as base64 of exactly 64 bytes.
 *
 * Wallets disagree about how to return a signature and the kit does not settle
 * it. Bitget hands back hex; Freighter passes a string through untouched and
 * base64-encodes only when it receives bytes. The type is `string` either way,
 * so nothing catches the difference until the server rejects it — which reads
 * as "wrong account" rather than "wrong encoding", and sends you looking in the
 * wrong place.
 *
 * Every shape is converted here so the server receives one. Anything that does
 * not decode to 64 bytes is refused rather than forwarded: a signature the
 * server cannot read is not worth a round trip, and failing here names the
 * problem while the wallet is still in hand.
 */
export function toBase64Signature(signed: unknown): string {
  if (signed instanceof Uint8Array) {
    return requireSignatureLength(Buffer.from(signed))
  }

  // A byte array that crossed a JSON boundary arrives as a plain array, and as
  // a keyed object when it crossed twice.
  if (Array.isArray(signed) && signed.every((b) => typeof b === 'number')) {
    return requireSignatureLength(Buffer.from(signed as number[]))
  }

  if (typeof signed !== 'string' || signed === '') {
    throw new Error('The wallet returned a signature in a form this app cannot read.')
  }

  // Hex and base64 cannot be told apart by inspection, by alphabet, or by
  // length. Base64 of 96 zero bytes is 128 characters of "A": valid hex, the
  // same length as hex of a real signature, and it decodes down the hex path to
  // exactly 64 bytes. Trying hex first therefore reinterprets a wrong-sized
  // signature as a plausible one and forwards it to the server.
  //
  // Base64 goes first because it is what almost every wallet returns, so a
  // string that decodes cleanly from base64 to 64 bytes is taken at face value.
  // Hex is the fallback for the wallets that use it, reached only when base64
  // did not already give the right answer.
  // Base64 first, because it is what almost every wallet returns.
  const asBase64 = Buffer.from(signed, 'base64')
  if (asBase64.length === SIGNATURE_BYTES) return asBase64.toString('base64')

  // Then hex, for the wallets that use it.
  //
  // One genuine ambiguity survives and is worth naming: a 128-character
  // hex-alphabet string is valid hex for 64 bytes *and* valid base64 for 96.
  // Nothing distinguishes them — not length, not alphabet — so hex wins,
  // because that is the reading a wallet actually intends at that length. The
  // alternative case, a 96-byte base64 signature made only of hex characters,
  // is not something a wallet produces; it only appears if someone constructs
  // it deliberately, and the server rejects it either way.
  if (/^[0-9a-f]+$/i.test(signed) && signed.length % 2 === 0) {
    const asHex = Buffer.from(signed, 'hex')
    if (asHex.length === SIGNATURE_BYTES) return asHex.toString('base64')
  }

  // Comma-separated byte values. Not a wallet format, but it is what
  // `String(bytes)` produces, and that mistake is easy to make in a caller.
  if (/^\d{1,3}(,\d{1,3})+$/.test(signed)) {
    return requireSignatureLength(Buffer.from(signed.split(',').map(Number)))
  }

  const decoded = Buffer.from(signed, 'base64')
  // `Buffer.from` never throws on bad base64, it truncates. So the length check
  // is the only thing standing between a mangled signature and the server.
  return requireSignatureLength(decoded)
}

function requireSignatureLength(bytes: Buffer): string {
  if (bytes.length !== SIGNATURE_BYTES) {
    throw new Error(
      `The wallet returned a ${bytes.length}-byte signature; ${SIGNATURE_BYTES} were expected.`
    )
  }
  return bytes.toString('base64')
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
    networkPassphrase: stellarNetwork.networkPassphrase,
  })

  if (signed.signedMessage === null || signed.signedMessage === undefined) {
    throw new Error('Signature declined.')
  }

  const session = await apiRequest<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: {
      address,
      nonce: challenge.nonce,
      signature: toBase64Signature(signed.signedMessage),
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
