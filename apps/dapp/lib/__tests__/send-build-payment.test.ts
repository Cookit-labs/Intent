import { stellarNetwork } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { assertSendPayment, buildSendPayment } from '../send/build-payment'
import type { SendExpectation } from '../send/build-payment'
import { USDC } from '../swap/assets'

/**
 * The second transaction in this app that pays a third party, and the gate
 * that admits it. Mirrors the offramp gate field for field: every refusal is
 * tested by building the wrong transaction directly, so a refusal names the
 * field rather than the builder misbehaving.
 */

const ME = Keypair.random().publicKey()
const THEM = Keypair.random().publicKey()
const NET = stellarNetwork.networkPassphrase
const USDC_ASSET = new Asset(USDC.code, USDC.issuer as string)
const HASH_B64 = Buffer.alloc(32, 7).toString('base64')

const XLM_EXPECT: SendExpectation = {
  recipientInput: 'deon.xlm',
  destination: THEM,
  amount: '5',
  asset: { code: 'XLM' },
}

const USDC_EXPECT: SendExpectation = {
  recipientInput: 'alice*lobstr.co',
  destination: THEM,
  memo: 'order-7',
  memoType: 'text',
  amount: '12.5',
  asset: { code: USDC.code, issuer: USDC.issuer as string },
}

/** Horizon answering the sequence lookup. */
const horizon = ((url: string) =>
  Promise.resolve(
    new Response(JSON.stringify(url.includes(ME) ? { sequence: '100' } : {}), {
      status: url.includes(ME) ? 200 : 404,
    })
  )) as unknown as typeof fetch

interface Wrong {
  source?: string
  destination?: string
  asset?: Asset
  amount?: string
  memo?: Memo
  opSource?: string
  twoOps?: boolean
}

function payment(w: Wrong = {}): string {
  const b = new TransactionBuilder(new Account(w.source ?? ME, '100'), {
    fee: BASE_FEE,
    networkPassphrase: NET,
  }).addOperation(
    Operation.payment({
      destination: w.destination ?? THEM,
      asset: w.asset ?? Asset.native(),
      amount: w.amount ?? '5',
      ...(w.opSource !== undefined ? { source: w.opSource } : {}),
    })
  )
  if (w.twoOps === true) {
    b.addOperation(Operation.payment({ destination: THEM, asset: Asset.native(), amount: '1' }))
  }
  if (w.memo !== undefined) b.addMemo(w.memo)
  return b.setTimeout(180).build().toXDR()
}

describe('buildSendPayment', () => {
  it('builds a native payment the assertion accepts', async () => {
    const built = await buildSendPayment({
      account: ME,
      expectation: XLM_EXPECT,
      fetchImpl: horizon,
    })
    expect(() => assertSendPayment(built.xdr, ME, XLM_EXPECT)).not.toThrow()
    const tx = TransactionBuilder.fromXDR(built.xdr, NET)
    expect(tx.operations).toHaveLength(1)
    expect((tx as { memo: Memo }).memo.type).toBe('none')
    expect(built.networkPassphrase).toBe(NET)
  })

  it('builds an issued-asset payment with the memo the recipient named', async () => {
    const built = await buildSendPayment({
      account: ME,
      expectation: USDC_EXPECT,
      fetchImpl: horizon,
    })
    expect(() => assertSendPayment(built.xdr, ME, USDC_EXPECT)).not.toThrow()
    const tx = TransactionBuilder.fromXDR(built.xdr, NET)
    expect((tx as { memo: Memo }).memo.type).toBe('text')
  })

  it('refuses an unfunded account', async () => {
    await expect(
      buildSendPayment({
        account: Keypair.random().publicKey(),
        expectation: XLM_EXPECT,
        fetchImpl: horizon,
      })
    ).rejects.toThrow(/not funded/)
  })

  it('refuses to pay the signing account itself', async () => {
    await expect(
      buildSendPayment({
        account: ME,
        expectation: { ...XLM_EXPECT, destination: ME },
        fetchImpl: horizon,
      })
    ).rejects.toThrow(/yourself/)
  })
})

describe('assertSendPayment refuses', () => {
  const refuses = (label: string, xdr: string, pattern: RegExp, expectation = XLM_EXPECT) => {
    it(label, () => {
      expect(() => assertSendPayment(xdr, ME, expectation)).toThrow(pattern)
    })
  }

  refuses('a transaction sourced by another account', payment({ source: THEM }), /source/)
  refuses(
    'a payment to any account but the resolved one',
    payment({ destination: ME }),
    /destination/
  )
  refuses('an issued asset when XLM was asked for', payment({ asset: USDC_ASSET }), /asset/)
  refuses(
    'XLM when an issued asset was asked for',
    payment({ asset: Asset.native(), memo: Memo.text('order-7'), amount: '12.5' }),
    /asset/,
    USDC_EXPECT
  )
  refuses(
    'the wrong asset code',
    payment({
      asset: new Asset('EURC', USDC.issuer as string),
      memo: Memo.text('order-7'),
      amount: '12.5',
    }),
    /asset/,
    USDC_EXPECT
  )
  refuses(
    'the right code from the wrong issuer',
    payment({
      asset: new Asset('USDC', Keypair.random().publicKey()),
      memo: Memo.text('order-7'),
      amount: '12.5',
    }),
    /issuer/,
    USDC_EXPECT
  )
  refuses('an amount other than the one named', payment({ amount: '5.0000001' }), /amount/)
  refuses('a larger amount', payment({ amount: '50' }), /amount/)
  refuses('a memo when none was asked for', payment({ memo: Memo.text('hi') }), /memo/)
  refuses(
    'no memo when the recipient named one',
    payment({ asset: USDC_ASSET, amount: '12.5' }),
    /memo/,
    USDC_EXPECT
  )
  refuses(
    'the right memo bytes as the wrong type',
    payment({ asset: USDC_ASSET, amount: '12.5', memo: Memo.id('7') }),
    /memo/,
    { ...USDC_EXPECT, memo: '7', memoType: 'text' }
  )
  refuses('two operations', payment({ twoOps: true }), /exactly one/)
  refuses('a per-operation source', payment({ opSource: THEM }), /sourced/)

  it('a payment to the signing account, whatever the expectation says', () => {
    expect(() =>
      assertSendPayment(payment({ destination: ME }), ME, { ...XLM_EXPECT, destination: ME })
    ).toThrow(/yourself/)
  })

  it('a fee bump', () => {
    const inner = TransactionBuilder.fromXDR(payment(), NET)
    const bump = TransactionBuilder.buildFeeBumpTransaction(ME, '1000', inner as never, NET)
    expect(() => assertSendPayment(bump.toXDR(), ME, XLM_EXPECT)).toThrow(/fee.bump/)
  })

  it('a non-payment operation', () => {
    const xdr = new TransactionBuilder(new Account(ME, '100'), {
      fee: BASE_FEE,
      networkPassphrase: NET,
    })
      .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
      .setTimeout(180)
      .build()
      .toXDR()
    expect(() => assertSendPayment(xdr, ME, XLM_EXPECT)).toThrow(/payment/)
  })

  it('names both addresses when a name has moved', () => {
    // The sentence the user reads when a name they paid last week points
    // somewhere new today.
    const moved = Keypair.random().publicKey()
    expect(() => assertSendPayment(payment(), ME, { ...XLM_EXPECT, destination: moved })).toThrow(
      new RegExp(`${THEM}.*${moved}|${moved}.*${THEM}`)
    )
  })
})

describe('assertSendPayment accepts', () => {
  it('an amount written with trailing zeros', () => {
    expect(() => assertSendPayment(payment({ amount: '5.0000000' }), ME, XLM_EXPECT)).not.toThrow()
  })

  it('an id memo when the recipient asked for id', () => {
    const idExpect: SendExpectation = { ...XLM_EXPECT, memo: '4242', memoType: 'id' }
    expect(() => assertSendPayment(payment({ memo: Memo.id('4242') }), ME, idExpect)).not.toThrow()
  })

  it('a hash memo when the recipient asked for hash', () => {
    const hashExpect: SendExpectation = { ...XLM_EXPECT, memo: HASH_B64, memoType: 'hash' }
    expect(() =>
      assertSendPayment(
        payment({ memo: Memo.hash(Buffer.from(HASH_B64, 'base64')) }),
        ME,
        hashExpect
      )
    ).not.toThrow()
  })
})
