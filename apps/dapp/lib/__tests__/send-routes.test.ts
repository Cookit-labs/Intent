import { stellarTestnet } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NameLookupFailed, NameNotFound, UnsupportedRecipient } from '../names/errors'
import type { ResolvedRecipient } from '../names/resolve'

/**
 * The three send routes, with the resolver faked.
 *
 * What is pinned is the shape of the contract with the browser, and the one
 * property the whole feature rests on: the submit route resolves the name
 * *again* and refuses an envelope built for an address the name no longer
 * points at. The resolver is the only thing faked; the assertion reads the
 * real signed bytes.
 */

const resolve = vi.fn<(input: string) => Promise<ResolvedRecipient>>()

vi.mock('../names/resolve', () => ({
  resolveRecipient: (input: string) => resolve(input),
}))

const USER = Keypair.random()
const ME = USER.publicKey()
const THEM = Keypair.random().publicKey()

function post(body: unknown): Request {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function resolvedTo(address: string, input = 'deon.xlm'): ResolvedRecipient {
  return { input, kind: 'soroban-domain', address, resolvedOn: 'stellar-mainnet' }
}

/** A payment of 5 XLM to `destination`, signed by the user. */
function signedPayment(destination: string): string {
  const tx = new TransactionBuilder(new Account(ME, '100'), {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '5' }))
    .setTimeout(180)
    .build()
  tx.sign(USER)
  return tx.toXDR()
}

beforeEach(() => {
  resolve.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/send/resolve', () => {
  it('requires a recipient', async () => {
    const { POST } = await import('../../app/api/send/resolve/route')
    expect((await POST(post({}))).status).toBe(400)
    expect((await POST(post({ recipient: '' }))).status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('answers with the resolution', async () => {
    const { POST } = await import('../../app/api/send/resolve/route')
    resolve.mockResolvedValue(resolvedTo(THEM))

    const res = await POST(post({ recipient: 'deon.xlm' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(resolvedTo(THEM))
  })

  it('checks the account can receive the asset on testnet when asked to', async () => {
    const { POST } = await import('../../app/api/send/resolve/route')
    resolve.mockResolvedValue(resolvedTo(THEM))
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))

    const res = await POST(post({ recipient: 'deon.xlm', asset: 'XLM' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'cannot_receive' })
    expect((await POST(post({ recipient: 'deon.xlm', asset: 'XLM' }))).status).toBe(409)
  })

  it('answers with the resolution when the account can receive', async () => {
    const { POST } = await import('../../app/api/send/resolve/route')
    resolve.mockResolvedValue(resolvedTo(THEM))
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ balances: [{ asset_type: 'native', balance: '1' }] }), {
          status: 200,
        })
    )

    const res = await POST(post({ recipient: 'deon.xlm', asset: 'XLM' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(resolvedTo(THEM))
  })

  it('maps not found, lookup failed and unsupported to their statuses', async () => {
    const { POST } = await import('../../app/api/send/resolve/route')

    resolve.mockRejectedValueOnce(new NameNotFound('deon.xlm is not registered'))
    const notFound = await POST(post({ recipient: 'deon.xlm' }))
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({
      error: 'deon.xlm is not registered',
      code: 'not_found',
    })

    resolve.mockRejectedValueOnce(new NameLookupFailed('rpc down'))
    expect((await POST(post({ recipient: 'deon.xlm' }))).status).toBe(502)

    resolve.mockRejectedValueOnce(new UnsupportedRecipient('no'))
    expect((await POST(post({ recipient: 'my friend' }))).status).toBe(400)
  })
})

describe('POST /api/send/build', () => {
  it('requires account, asset, amount and recipient', async () => {
    const { POST } = await import('../../app/api/send/build/route')
    const full = { account: ME, asset: 'XLM', amount: '5', recipient: 'deon.xlm' }
    for (const key of ['account', 'asset', 'amount', 'recipient'] as const) {
      const { [key]: _drop, ...without } = full
      const res = await POST(post(without))
      expect(res.status, key).toBe(400)
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves on the server and returns the envelope with what it was built from', async () => {
    const { POST } = await import('../../app/api/send/build/route')
    resolve.mockResolvedValue(resolvedTo(THEM))
    // Horizon, answering the sequence lookup and the recipient's account.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(`/accounts/${ME}`) || url.includes(`/accounts/${THEM}`)) {
        return new Response(
          JSON.stringify({
            sequence: '100',
            balances: [{ asset_type: 'native', balance: '10.0000000' }],
          }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 404 })
    })

    const res = await POST(post({ account: ME, asset: 'XLM', amount: '5', recipient: 'deon.xlm' }))
    const body = (await res.json()) as {
      xdr?: string
      expectation?: { destination: string; amount: string; asset: { code: string } }
      resolved?: ResolvedRecipient
      preview?: { changes: { code: string; delta: string }[]; feePaidBy?: string }
    }

    expect(res.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith('deon.xlm')
    expect(body.expectation).toMatchObject({
      destination: THEM,
      amount: '5',
      asset: { code: 'XLM' },
    })
    expect(body.resolved).toEqual(resolvedTo(THEM))
    expect(body.preview?.changes).toEqual([{ code: 'XLM', delta: '-5', bound: 'exact' }])
    expect(body.preview?.feePaidBy).toMatch(/^(sponsor|account)$/)
    // The envelope pays the resolved address, not anything the client said.
    const tx = TransactionBuilder.fromXDR(body.xdr as string, stellarTestnet.networkPassphrase)
    expect((tx.operations[0] as { destination: string }).destination).toBe(THEM)
  })

  it('refuses, before building, a recipient whose account does not exist on testnet', async () => {
    // The common case for a `.xlm` name: it resolves on mainnet to an account
    // testnet has never seen. Refused here with the recipient named, rather
    // than after the signature as "no route could fill this swap".
    const { POST } = await import('../../app/api/send/build/route')
    resolve.mockResolvedValue(resolvedTo(THEM))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(`/accounts/${ME}`)) {
        return new Response(JSON.stringify({ sequence: '100' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })

    const res = await POST(post({ account: ME, asset: 'XLM', amount: '5', recipient: 'deon.xlm' }))

    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({
      code: 'cannot_receive',
      error: expect.stringMatching(/deon\.xlm.*does not exist on testnet/),
    })
  })

  it('reports a name that cannot be resolved with its status', async () => {
    const { POST } = await import('../../app/api/send/build/route')
    resolve.mockRejectedValue(new NameNotFound('nobody.xlm is not registered'))
    const res = await POST(
      post({ account: ME, asset: 'XLM', amount: '5', recipient: 'nobody.xlm' })
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'not_found' })
  })

  it('refuses an asset the app does not trade before resolving anything', async () => {
    const { POST } = await import('../../app/api/send/build/route')
    resolve.mockResolvedValue(resolvedTo(THEM))
    const res = await POST(post({ account: ME, asset: 'DOGE', amount: '5', recipient: 'deon.xlm' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/send/submit', () => {
  it('requires signedXdr, account, recipient, asset and amount', async () => {
    const { POST } = await import('../../app/api/send/submit/route')
    const full = {
      signedXdr: signedPayment(THEM),
      account: ME,
      recipient: 'deon.xlm',
      asset: 'XLM',
      amount: '5',
    }
    for (const key of ['signedXdr', 'account', 'recipient', 'asset', 'amount'] as const) {
      const { [key]: _drop, ...without } = full
      expect((await POST(post(without))).status, key).toBe(400)
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves the name again and refuses an envelope built for where it used to point', async () => {
    const { POST } = await import('../../app/api/send/submit/route')
    const moved = Keypair.random().publicKey()
    resolve.mockResolvedValue(resolvedTo(moved))

    const res = await POST(
      post({
        signedXdr: signedPayment(THEM),
        account: ME,
        recipient: 'deon.xlm',
        asset: 'XLM',
        amount: '5',
      })
    )
    const body = (await res.json()) as { error?: string }

    expect(res.status).toBe(400)
    expect(resolve).toHaveBeenCalledWith('deon.xlm')
    // Both addresses, so the user can see the name moved rather than guess.
    expect(body.error).toContain(THEM)
    expect(body.error).toContain(moved)
  })

  it('refuses to submit when the name cannot be resolved now', async () => {
    const { POST } = await import('../../app/api/send/submit/route')
    resolve.mockRejectedValue(new NameLookupFailed('rpc down'))

    const res = await POST(
      post({
        signedXdr: signedPayment(THEM),
        account: ME,
        recipient: 'deon.xlm',
        asset: 'XLM',
        amount: '5',
      })
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'lookup_failed' })
  })

  it('refuses an envelope whose amount is not the one named', async () => {
    const { POST } = await import('../../app/api/send/submit/route')
    resolve.mockResolvedValue(resolvedTo(THEM))

    const res = await POST(
      post({
        signedXdr: signedPayment(THEM),
        account: ME,
        recipient: 'deon.xlm',
        asset: 'XLM',
        amount: '50',
      })
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/amount/)
  })
})
