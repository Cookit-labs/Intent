import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { SESSION_COOKIE } from './lib/server/session-constants'

/**
 * Blocks the dApp behind the access gate.
 *
 * Runs in middleware rather than a client-side check so that routes are
 * genuinely unreachable without a valid session — a component-level guard is
 * only a rendering decision and can be stepped around.
 *
 * This file runs on the edge runtime, which has no `node:crypto`, so signature
 * verification uses Web Crypto here instead of the Node helpers in
 * `lib/server/session.ts`. The two must agree on the format; both are HMAC-SHA256
 * over the base64url payload, and `session.test.ts` covers the shared contract.
 */

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function isValidSession(token: string | undefined, secret: string): Promise<boolean> {
  if (token === undefined || token === '') return false

  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [encoded, signature] = parts as [string, string]

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const expected = bytesToBase64Url(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded))
  )

  if (expected !== signature) return false

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as {
      email?: unknown
      exp?: unknown
    }
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return false
    return payload.exp * 1000 > Date.now()
  } catch {
    return false
  }
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const secret = process.env['AUTH_SECRET']

  // Without a secret the gate cannot verify anything. Failing closed would make
  // a misconfigured dev environment look like a broken app, so this fails open
  // in development and closed in production.
  if (secret === undefined || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Access gate misconfigured', { status: 503 })
    }
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (await isValidSession(token, secret)) return NextResponse.next()

  const url = request.nextUrl.clone()
  url.pathname = '/verify'
  // Preserved so a verified user lands where they were originally headed.
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCESS GATE DISABLED
 *
 * The waitlist/OTP gate was built from a prompt intended for a different
 * project, so nothing in the dApp is gated. The implementation is kept intact
 * rather than deleted, in case Intent wants it later.
 *
 * To switch it back on, restore the matcher below. Nothing else needs changing —
 * the routes, API handlers and datastores are all still here.
 *
 *   matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon|verify|waitlist|admin).*)'],
 *
 * An empty matcher means middleware runs on no path at all, so every route is
 * open. `/verify`, `/waitlist` and `/admin/waitlist` still render if visited
 * directly; they are simply unreachable by redirect.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const config = {
  matcher: [],
}
