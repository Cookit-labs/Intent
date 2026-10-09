import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  NETWORK_HEADER,
  defaultNetwork,
  enabledNetworks,
  homeSegment,
  resolveRequestedNetwork,
} from '@intent/config'

import { gateEnabled } from './lib/server/access-gate'
import { constantTimeEqual } from './lib/server/constant-time-equal'
import {
  bareRedirect,
  isGateFree,
  legacyStellarRedirect,
  segmentNetwork,
} from './lib/server/network-route'
import { SESSION_COOKIE } from './lib/server/session-constants'

/**
 * Blocks the dApp behind the access gate.
 *
 * Runs in middleware rather than a client-side check so that routes are
 * genuinely unreachable without a valid session — a component-level guard is
 * only a rendering decision and can be stepped around.
 *
 * Whether it runs at all is `ACCESS_GATE` (see `lib/server/access-gate.ts`):
 * on by default for mainnet, off for testnet. `matcher` is static, so the
 * switch is the first thing the handler checks rather than a change to the
 * config below.
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

  if (!constantTimeEqual(expected, signature)) return false

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
  const fallback = defaultNetwork()
  const enabled = enabledNetworks()
  const multi = enabled.length > 1
  const { pathname, search } = request.nextUrl
  const isApi = pathname.startsWith('/api/')

  // An address from before network segments existed: send it to the default
  // network's own, so the page and everything it calls agree on the network.
  if (!isApi) {
    const moved = legacyStellarRedirect(pathname, search, multi, fallback)
    if (moved !== undefined) return NextResponse.redirect(new URL(moved, request.url))

    // The bare root and the old unprefixed screens open on the home chain.
    const home = bareRedirect(pathname, search, homeSegment(enabled))
    if (home !== undefined) return NextResponse.redirect(new URL(home, request.url))
  }

  // Which network this request is for. A page says it in its address; an API
  // call says it in a header the app's own fetch adds. Either is checked
  // against what this deployment serves, and anything else is the default.
  const requested = isApi
    ? request.headers.get(NETWORK_HEADER)
    : (segmentNetwork(pathname.split('/')[1] ?? '') ?? null)
  const network = resolveRequestedNetwork(requested, enabled, fallback)

  // The one copy server code trusts. Always written here, never passed
  // through: a client that sends its own is overwritten, not believed.
  const forwarded = new Headers(request.headers)
  forwarded.set(NETWORK_HEADER, network)
  const pass = (): NextResponse => NextResponse.next({ request: { headers: forwarded } })

  // The API answers with its own checks, and the verification, waitlist and
  // admin pages are where an unverified visitor is sent.
  if (isApi || isGateFree(pathname)) return pass()
  if (!gateEnabled(process.env, network)) return pass()

  const secret = process.env['AUTH_SECRET']

  // Without a secret the gate cannot verify anything. Failing closed would make
  // a misconfigured dev environment look like a broken app, so this fails open
  // in development and closed in production.
  if (secret === undefined || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Access gate misconfigured', { status: 503 })
    }
    return pass()
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (await isValidSession(token, secret)) return pass()

  const url = request.nextUrl.clone()
  url.pathname = '/verify'
  // Preserved so a verified user lands where they were originally headed.
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

/**
 * Every page and every API route, so each carries a network. The gate has its
 * own exemptions inside the handler (`isGateFree`, and the API altogether);
 * only static assets are left out here.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon).*)'],
}
