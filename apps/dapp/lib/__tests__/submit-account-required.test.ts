import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `account` is required on every submit route.
 *
 * The re-assertion at submit exists for one adversary: something between
 * build and broadcast that alters the bytes and picks the endpoint. On the
 * swap, plan and offer routes it ran only when the body named an account, so
 * that adversary could skip it by dropping one JSON field, and the app would
 * broadcast a transaction it would have refused. Lend, send and offramp
 * always required it; these three now do too.
 *
 * The network is faked at the module boundary so nothing is broadcast; what
 * is pinned is that it is never asked to be.
 */

const submit = vi.fn(async () => ({ ok: true, hash: 'h' }))

vi.mock('../swap/submit', () => ({
  submitSignedSwap: (xdr: string) => submit(xdr),
}))

vi.mock('../server/rate-limit', () => ({
  enforceRateLimit: async () => undefined,
}))

const USER = Keypair.random()
const STRANGER = Keypair.random().publicKey()

/** A payment to a stranger, signed by the user: what every assertion refuses. */
function paysStranger(): string {
  const tx = new TransactionBuilder(new Account(USER.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: STRANGER, asset: Asset.native(), amount: '5' }))
    .setTimeout(180)
    .build()
  tx.sign(USER)
  return tx.toXDR()
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

type Route = { POST: (request: Request) => Promise<Response> }

const ROUTES: [string, () => Promise<Route>][] = [
  ['swap/submit', () => import('../../app/api/swap/submit/route')],
  ['plan/submit', () => import('../../app/api/plan/submit/route')],
  ['offers/submit', () => import('../../app/api/offers/submit/route')],
]

beforeEach(() => {
  submit.mockClear()
})

describe.each(ROUTES)('POST /api/%s', (path, load) => {
  it('refuses a body without an account, and broadcasts nothing', async () => {
    const { POST } = await load()

    const res = await POST(post(path, { signedXdr: paysStranger() }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'account is required' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('treats an empty account as missing', async () => {
    const { POST } = await load()

    const res = await POST(post(path, { signedXdr: paysStranger(), account: '' }))

    expect(res.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
  })

  it('refuses the same envelope when the account is named, as it always did', async () => {
    const { POST } = await load()

    const res = await POST(post(path, { signedXdr: paysStranger(), account: USER.publicKey() }))

    expect(res.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
  })
})
