import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSession } from '../server/session'
import { SESSION_COOKIE } from '../server/session-constants'

/**
 * The submit routes sponsor through the gate.
 *
 * `sponsorForRequest` makes the decision (see sponsor-request.test.ts); what
 * is pinned here is that the routes actually hand it the request. With the
 * gate on, a submission without a session goes out unsponsored and the
 * sponsor is never asked; with a session it is sponsored as before. The
 * swap, plan and offer routes take a self-directed envelope and nothing
 * else, so they are exercised end to end; lend, send and offramp need a
 * Blend call, a resolver or an anchor to reach the sponsor, and for those
 * the wiring is pinned by reading the source.
 */

const sponsored =
  vi.fn<(xdr: string) => Promise<{ xdr: string; sponsored: true; feeStroops: string }>>()

vi.mock('../sponsor/sponsor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sponsor/sponsor')>()
  return { ...actual, sponsorForSubmission: (xdr: string) => sponsored(xdr) }
})

vi.mock('../swap/submit', () => ({
  submitSignedSwap: async () => ({ ok: true, hash: 'h' }),
}))

vi.mock('../server/rate-limit', () => ({
  enforceRateLimit: async () => undefined,
}))

const USER = Keypair.random()
const ME = USER.publicKey()
const USDC = new Asset('USDC', Keypair.random().publicKey())
const SECRET = 'a'.repeat(48)

function signed(op: ReturnType<typeof selfSwap>): string {
  const tx = new TransactionBuilder(new Account(ME, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(180)
    .build()
  tx.sign(USER)
  return tx.toXDR()
}

const selfSwap = () =>
  Operation.pathPaymentStrictSend({
    sendAsset: Asset.native(),
    sendAmount: '1',
    destination: ME,
    destAsset: USDC,
    destMin: '1',
    path: [],
  })

const offer = () =>
  Operation.manageSellOffer({
    selling: Asset.native(),
    buying: USDC,
    amount: '1',
    price: '1',
    offerId: '0',
  })

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
}

type Route = { POST: (request: Request) => Promise<Response> }

const ROUTES: [string, () => Promise<Route>, () => ReturnType<typeof selfSwap>][] = [
  ['swap/submit', () => import('../../app/api/swap/submit/route'), selfSwap],
  ['plan/submit', () => import('../../app/api/plan/submit/route'), selfSwap],
  ['offers/submit', () => import('../../app/api/offers/submit/route'), offer],
]

beforeEach(() => {
  process.env['ACCESS_GATE'] = 'on'
  process.env['AUTH_SECRET'] = SECRET
  sponsored.mockReset()
  sponsored.mockImplementation(async (xdr) => ({ xdr, sponsored: true, feeStroops: '200' }))
})

afterEach(() => {
  delete process.env['ACCESS_GATE']
  delete process.env['AUTH_SECRET']
})

describe.each(ROUTES)('POST /api/%s with the gate on', (path, load, op) => {
  it('submits unsponsored, without asking the sponsor, when there is no session', async () => {
    const { POST } = await load()

    const res = await POST(post(path, { signedXdr: signed(op()), account: ME }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, feeSponsored: false })
    expect(sponsored).not.toHaveBeenCalled()
  })

  it('sponsors a submission that carries a session', async () => {
    const { POST } = await load()
    const cookie = `${SESSION_COOKIE}=${createSession('tester@example.com')}`

    const res = await POST(post(path, { signedXdr: signed(op()), account: ME }, cookie))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, feeSponsored: true })
    expect(sponsored).toHaveBeenCalledTimes(1)
  })
})

describe('every submit route decides through sponsorForRequest', () => {
  it.each(['swap', 'plan', 'offers', 'lend', 'send', 'offramp'])('api/%s/submit', (name) => {
    const source = readFileSync(join(process.cwd(), 'app/api', name, 'submit/route.ts'), 'utf8')
    expect(source).toContain('sponsorForRequest(request,')
    expect(source).not.toContain('sponsorForSubmission(')
  })
})
