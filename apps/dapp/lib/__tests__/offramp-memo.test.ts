import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { memoFromAnchor, memoMatches } from '../offramp/memo'

/**
 * The memo is what attributes a payment to a withdrawal on an account the
 * anchor shares across all its users. A memo of the right value and the
 * wrong type is a lost payment, so both are checked, and the hash form —
 * base64 on the wire, raw bytes in the transaction — is round-tripped here.
 */

const ME = Keypair.random().publicKey()
const THEM = Keypair.random().publicKey()

/** A payment carrying `memo`, decoded again as the assertion will see it. */
function decodedWith(memo: Memo): Memo {
  const xdr = new TransactionBuilder(new Account(ME, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: THEM, asset: Asset.native(), amount: '1' }))
    .addMemo(memo)
    .setTimeout(60)
    .build()
    .toXDR()
  return (TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as any).memo
}

const HASH_B64 = Buffer.alloc(32, 7).toString('base64')

describe('memoFromAnchor', () => {
  it('decodes a base64 hash memo into 32 bytes', () => {
    const memo = memoFromAnchor(HASH_B64, 'hash')
    expect(memo.type).toBe('hash')
    expect(Buffer.from(memo.value as Uint8Array).equals(Buffer.alloc(32, 7))).toBe(true)
  })

  it('refuses a hash that does not decode to 32 bytes', () => {
    expect(() => memoFromAnchor(Buffer.alloc(31, 1).toString('base64'), 'hash')).toThrow(/32/)
  })

  it('builds an id memo from a decimal string', () => {
    expect(memoFromAnchor('123456', 'id').type).toBe('id')
  })

  it('refuses an id that is not an unsigned integer', () => {
    expect(() => memoFromAnchor('-1', 'id')).toThrow(/unsigned/)
    expect(() => memoFromAnchor('abc', 'id')).toThrow(/unsigned/)
  })

  it('builds a text memo', () => {
    expect(memoFromAnchor('withdraw 42', 'text').type).toBe('text')
  })

  it('refuses text over 28 bytes', () => {
    expect(() => memoFromAnchor('x'.repeat(29), 'text')).toThrow(/28/)
  })
})

describe('memoMatches on a decoded transaction', () => {
  it('matches a hash memo by bytes', () => {
    const memo = decodedWith(memoFromAnchor(HASH_B64, 'hash'))
    expect(memoMatches(memo, HASH_B64, 'hash')).toBe(true)
    expect(memoMatches(memo, Buffer.alloc(32, 8).toString('base64'), 'hash')).toBe(false)
  })

  it('matches a text memo by string', () => {
    const memo = decodedWith(Memo.text('order-9'))
    expect(memoMatches(memo, 'order-9', 'text')).toBe(true)
    expect(memoMatches(memo, 'order-8', 'text')).toBe(false)
  })

  it('matches an id memo by value', () => {
    const memo = decodedWith(Memo.id('987'))
    expect(memoMatches(memo, '987', 'id')).toBe(true)
    expect(memoMatches(memo, '986', 'id')).toBe(false)
  })

  it('does not match across types, even with equal bytes', () => {
    // A text memo whose bytes spell the id is still the wrong type; the
    // anchor's matcher keys on both.
    const memo = decodedWith(Memo.text('987'))
    expect(memoMatches(memo, '987', 'id')).toBe(false)
  })

  it('never matches a transaction with no memo', () => {
    const memo = decodedWith(Memo.none())
    expect(memoMatches(memo, 'anything', 'text')).toBe(false)
  })
})
