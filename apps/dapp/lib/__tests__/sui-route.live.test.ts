import { Transaction } from '@mysten/sui/transactions'
import { describe, expect, it } from 'vitest'

import { suiModule } from '../chains/sui/module'
import type { PreparedAction } from '../chains/types'

/**
 * The prepare route on a running app, which is what proves these packages survive
 * Next's bundler. It only runs when pointed at a server, and it only builds:
 * nothing is signed or sent.
 *
 *   SUI_ROUTE_BASE=https://localhost:3001 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     pnpm exec vitest run lib/__tests__/sui-route.live.test.ts
 */

const BASE = process.env['SUI_ROUTE_BASE']
const SKIP = process.env['SKIP_LIVE'] === '1' || BASE === undefined
const ACCOUNT = '0xc6fa48a7455bff49124318d5297320441cfac33f83ceea890c485372de917df4'
const TIMEOUT = 90_000

async function post(
  request: Record<string, string>,
  account = ACCOUNT
): Promise<{ status: number; body: { prepared?: PreparedAction; error?: string } }> {
  const response = await fetch(`${BASE}/api/chain/sui/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, request }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  return { status: response.status, body: (await response.json()) as never }
}

describe.skipIf(SKIP)('the Sui prepare route', () => {
  it.each([
    ['cetus', { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SUI' }],
    ['cetus', { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'USDsui', venue: 'cetus' }],
    ['navi', { kind: 'supply', amount: '1', tokenIn: 'USDC' }],
    ['navi', { kind: 'supply', amount: '1', tokenIn: 'USDC', venue: 'navi' }],
    ['springsui', { kind: 'stake', amount: '1', tokenIn: 'SUI' }],
  ])(
    '%s returns something that parses and passes the safety check',
    async (venueId, request) => {
      const { status, body } = await post(request)
      expect(body.error).toBeUndefined()
      expect(status).toBe(200)
      const prepared = body.prepared as PreparedAction
      expect(prepared.venueId).toBe(venueId)
      if (prepared.signing.family !== 'sui') throw new Error('wrong family')
      expect(Transaction.from(prepared.signing.transaction).getData().sender).toBe(ACCOUNT)
      const venue = suiModule.venues.find((v) => v.id === venueId)
      expect(() => venue?.assertSafe(prepared.signing, ACCOUNT)).not.toThrow()
    },
    TIMEOUT
  )

  it.each([
    [
      'an unknown token',
      { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'FDUSD' },
      /verified/,
    ],
    ['a token in that is unknown', { kind: 'supply', amount: '1', tokenIn: 'SCAM' }, /verified/],
    [
      'over the cap',
      { kind: 'swap', amount: '501', tokenIn: 'USDC', tokenOut: 'SUI' },
      /\$?500|limit|cap/i,
    ],
    [
      'a named venue that cannot do this',
      { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'SUI', venue: 'navi' },
      /can't swap/,
    ],
    [
      'a listed venue that is not wired',
      { kind: 'supply', amount: '1', tokenIn: 'USDC', venue: 'suilend' },
      /can't supply/,
    ],
    ['staking anything but SUI', { kind: 'stake', amount: '1', tokenIn: 'USDC' }, /stakes SUI/],
    [
      'a listed staker that is not wired',
      { kind: 'stake', amount: '1', tokenIn: 'SUI', venue: 'haedal' },
      /can't stake/,
    ],
    [
      'the same token twice',
      { kind: 'swap', amount: '1', tokenIn: 'USDC', tokenOut: 'usdc' },
      /same/,
    ],
    [
      'more precision than the token has',
      { kind: 'supply', amount: '1.1234567', tokenIn: 'USDC' },
      /decimal/,
    ],
    ['NAVI with another coin', { kind: 'supply', amount: '1', tokenIn: 'USDT' }, /USDC/],
  ])(
    'refuses %s',
    async (_name, request, reason) => {
      const { status, body } = await post(request as Record<string, string>)
      expect(status).toBe(422)
      expect(body.error).toMatch(reason)
    },
    TIMEOUT
  )

  it(
    'refuses an account from another chain',
    async () => {
      const { status, body } = await post(
        { kind: 'supply', amount: '1', tokenIn: 'USDC' },
        'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
      )
      expect(status).toBe(422)
      expect(body.error).toMatch(/Sui address/)
    },
    TIMEOUT
  )
})
