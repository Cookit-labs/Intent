import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The admin's session.
 *
 * `ADMIN_TOKEN` is typed once; what the browser then holds is a signed, expiring,
 * http-only cookie, so the token itself never sits in page state or storage and a
 * reload does not ask for it again. The token in an `x-admin-token` header still
 * works, for scripts.
 *
 * Kept apart from the tester session on purpose. Its payload names the role and
 * its signature covers a prefix the tester cookie never has, so a tester's cookie
 * cannot be replayed as an admin's, nor the other way round.
 */

export const ADMIN_COOKIE = 'intent_admin'
export const ADMIN_TTL_SECONDS = 8 * 60 * 60

const DOMAIN = 'admin:'

function secret(): string | undefined {
  const value = process.env['AUTH_SECRET']
  return value !== undefined && value.length >= 32 ? value : undefined
}

function sign(encoded: string, key: string): string {
  return createHmac('sha256', key).update(`${DOMAIN}${encoded}`).digest('base64url')
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Whether a typed token is the configured admin token. False when none is set or it is too short. */
export function adminTokenMatches(provided: string | null | undefined): boolean {
  const expected = process.env['ADMIN_TOKEN']
  if (expected === undefined || expected.length < 16) return false
  return equal(provided ?? '', expected)
}

/** A cookie value for a verified admin, or undefined when there is no secret to sign with. */
export function createAdminSession(now = Date.now()): string | undefined {
  const key = secret()
  if (key === undefined) return undefined
  const payload = { role: 'admin', exp: Math.floor(now / 1000) + ADMIN_TTL_SECONDS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, key)}`
}

/** Whether a cookie value is a genuine, unexpired admin session. Never throws on hostile input. */
export function readAdminSession(token: string | undefined, now = Date.now()): boolean {
  const key = secret()
  if (key === undefined || token === undefined || token === '') return false

  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [encoded, signature] = parts as [string, string]
  if (!equal(signature, sign(encoded, key))) return false

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
      role?: unknown
      exp?: unknown
    }
    return payload.role === 'admin' && typeof payload.exp === 'number' && payload.exp * 1000 > now
  } catch {
    return false
  }
}

function cookieFrom(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== ADMIN_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Whether a request comes from the admin: a valid session cookie, or the token in a header. */
export function isAdminRequest(request: Request, now = Date.now()): boolean {
  if (readAdminSession(cookieFrom(request), now)) return true
  return adminTokenMatches(request.headers.get('x-admin-token'))
}

export const adminCookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
  maxAge: ADMIN_TTL_SECONDS,
  // Omitted in development: localhost over plain HTTP would drop a secure cookie.
  secure: process.env.NODE_ENV === 'production',
} as const
