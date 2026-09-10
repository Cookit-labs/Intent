import { describe, expect, it } from 'vitest'
import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, Account } from '@stellar/stellar-sdk'
import { stellarTestnet } from '@intent/config'

import { assertSelfSwap } from '../swap/build-tx'
import { FAILURE_MESSAGES, submitSignedSwap } from '../swap/submit'

const me = Keypair.random().publicKey()
const stranger = Keypair.random().publicKey()

function tx(build: (b: TransactionBuilder) => TransactionBuilder): string {
  const account = new Account(me, '1')
  const b = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellarTestnet.networkPassphrase,
  })
  return build(b).setTimeout(120).build().toXDR()
}

/**
 * The property that makes "agents cannot move funds to third parties"
 * structural rather than a promise in a prompt.
 */
describe('assertSelfSwap', () => {
  it('accepts a swap that pays the sender', () => {
    const xdr = tx((b) =>
      b.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '30',
          destination: me,
          destAsset: Asset.native(),
          destMin: '29',
          path: [],
        })
      )
    )
    expect(() => assertSelfSwap(xdr, me)).not.toThrow()
  })

  it('REFUSES a payment to somebody else', () => {
    const xdr = tx((b) =>
      b.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '30',
          destination: stranger,
          destAsset: Asset.native(),
          destMin: '29',
          path: [],
        })
      )
    )
    expect(() => assertSelfSwap(xdr, me)).toThrow(/not the sending account/)
  })

  it('refuses a plain payment operation, swap or not', () => {
    const xdr = tx((b) =>
      b.addOperation(Operation.payment({ destination: stranger, asset: Asset.native(), amount: '30' }))
    )
    expect(() => assertSelfSwap(xdr, me)).toThrow(/is not a swap/)
  })

  it('refuses a transaction carrying more than one operation', () => {
    // Guards against a second operation being smuggled alongside the swap.
    const xdr = tx((b) =>
      b
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: Asset.native(),
            sendAmount: '30',
            destination: me,
            destAsset: Asset.native(),
            destMin: '29',
            path: [],
          })
        )
        .addOperation(Operation.payment({ destination: stranger, asset: Asset.native(), amount: '1' }))
    )
    expect(() => assertSelfSwap(xdr, me)).toThrow(/exactly one operation/)
  })

  it('refuses when the transaction source is a different account', () => {
    const xdr = tx((b) =>
      b.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '30',
          destination: stranger,
          destAsset: Asset.native(),
          destMin: '29',
          path: [],
        })
      )
    )
    expect(() => assertSelfSwap(xdr, stranger)).toThrow(/source/)
  })
})

function respond(payload: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status }))) as unknown as typeof fetch
}

describe('submitSignedSwap', () => {
  it('returns a hash and explorer link on success', async () => {
    const r = await submitSignedSwap('xdr', {
      fetchImpl: respond({ hash: 'abc123', ledger: 42, successful: true }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.hash).toBe('abc123')
    expect(r.explorerUrl).toContain('abc123')
  })

  it('treats a 200 with successful:false as a failure', async () => {
    // The trap: reaching a ledger is not the same as filling.
    const r = await submitSignedSwap('xdr', {
      fetchImpl: respond({
        hash: 'abc',
        successful: false,
        extras: { result_codes: { operations: ['op_under_dest_min'] } },
      }),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('under_dest_min')
    expect(r.hash).toBe('abc')
  })

  it.each([
    [['op_under_dest_min'], 'under_dest_min'],
    [['op_no_trust'], 'no_trustline'],
    [['op_underfunded'], 'underfunded'],
    [['op_too_few_offers'], 'no_path'],
  ])('maps %s to %s', async (ops, expected) => {
    const r = await submitSignedSwap('xdr', {
      fetchImpl: respond({ extras: { result_codes: { operations: ops } } }, 400),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(expected)
  })

  it('has a human message for every failure', () => {
    for (const msg of Object.values(FAILURE_MESSAGES)) {
      expect(msg.length).toBeGreaterThan(10)
    }
  })

  it('reports a dead network without throwing', async () => {
    const r = await submitSignedSwap('xdr', {
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('network_error')
  })
})
