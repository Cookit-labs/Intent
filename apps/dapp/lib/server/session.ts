import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed session values for the access gate.
 *
 * Deliberately not a JWT: the payload is an email and an expiry, and a JWT
 * library would add algorithm negotiation — the source of the `alg: none` class
 * of bugs — for no benefit at this size. HMAC-SHA256 over a compact string is
 * the whole requirement.
 *
 * Kept free of `next/headers` so it can be unit-tested and used from middleware,
 * which runs on the edge runtime.
 */
export { SESSION_COOKIE, SESSION_TTL_SECONDS } from './session-constants'

import { SESSION_TTL_SECONDS as TTL } from './session-constants'

export interface SessionPayload {
  email: string
  /** Unix seconds. */
  exp: number
}

function getSecret(): string {
  const secret = process.env['AUTH_SECRET']
  if (secret === undefined || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set to at least 32 characters')
  }
  return secret
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function createSession(email: string, now = Date.now()): string {
  const payload: SessionPayload = {
    email,
    exp: Math.floor(now / 1000) + TTL,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, getSecret())}`
}

/**
 * Returns the payload only for a token whose signature verifies and whose
 * expiry is in the future. Any malformed input returns undefined rather than
 * throwing, because this runs on attacker-controlled cookie values.
 */
export function readSession(token: string | undefined, now = Date.now()): SessionPayload | undefined {
  if (token === undefined || token === '') return undefined

  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [encoded, signature] = parts as [string, string]

  const expected = sign(encoded, getSecret())
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as SessionPayload
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return undefined
    if (payload.exp * 1000 <= now) return undefined
    return payload
  } catch {
    return undefined
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: TTL,
  // Secure is omitted in dev because localhost is plain HTTP and the browser
  // would silently drop the cookie, making the gate impossible to test.
  secure: process.env.NODE_ENV === 'production',
} as const
