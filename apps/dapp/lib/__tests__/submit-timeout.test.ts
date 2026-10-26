import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { FAILURE_MESSAGES, submitSignedSwap, transactionHashOf } from '../swap/submit'

/**
 * Horizon answers a slow confirmation with a 504 (or an empty reply), and the
 * transaction can still land a moment later. Reporting that as "could not
 * reach the network" told users a swap failed while it was settling, so a
 * submission that timed out is looked up by its hash before anything is said.
 */

function signedXdr(): string {
  const source = Keypair.random()
  const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(30)
    .build()
  tx.sign(source)
  return tx.toXDR()
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fast = { pollMs: 1, pollTimeoutMs: 20, networkPassphrase: Networks.PUBLIC }

describe('submitSignedSwap after a Horizon timeout', () => {
  it('reports the swap settled when it lands after a 504', async () => {
    const xdr = signedXdr()
    const hash = transactionHashOf(xdr, Networks.PUBLIC)
    let lookups = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') {
        return json({ type: 'https://stellar.org/horizon-errors/timeout', status: 504 }, 504)
      }
      lookups += 1
      return lookups < 2 ? json({ status: 404 }, 404) : json({ hash, ledger: 42, successful: true })
    }
    const result = await submitSignedSwap(xdr, { ...fast, fetchImpl })
    expect(result).toMatchObject({ ok: true, hash, ledger: 42 })
  })

  it('looks the transaction up when the POST never answered', async () => {
    const xdr = signedXdr()
    const hash = transactionHashOf(xdr, Networks.PUBLIC)
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') throw new TypeError('fetch failed')
      return json({ hash, ledger: 7, successful: true })
    }
    const result = await submitSignedSwap(xdr, { ...fast, fetchImpl })
    expect(result).toMatchObject({ ok: true, hash })
  })

  it('says it is unconfirmed, with the hash, when it never shows up', async () => {
    const xdr = signedXdr()
    const hash = transactionHashOf(xdr, Networks.PUBLIC)
    const fetchImpl: typeof fetch = async (_input, init) =>
      init?.method === 'POST'
        ? new Response('<html>Gateway Timeout</html>', { status: 504 })
        : json({}, 404)
    const result = await submitSignedSwap(xdr, { ...fast, fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'unconfirmed', hash })
    expect(FAILURE_MESSAGES.unconfirmed).toMatch(/may still go through/)
  })

  it('reports a transaction that landed and failed as failed', async () => {
    const xdr = signedXdr()
    const hash = transactionHashOf(xdr, Networks.PUBLIC)
    const fetchImpl: typeof fetch = async (_input, init) =>
      init?.method === 'POST' ? json({}, 504) : json({ hash, ledger: 9, successful: false })
    const result = await submitSignedSwap(xdr, { ...fast, fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'rejected', hash })
  })
})
