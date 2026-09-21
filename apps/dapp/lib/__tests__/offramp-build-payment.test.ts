// apps/dapp/lib/__tests__/offramp-build-payment.test.ts
import { stellarTestnet } from '@intent/config'
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

import { ANCHORS } from '../offramp/anchors'
import {
  assertOfframpPayment,
  buildOfframpPayment,
  expectationFrom,
} from '../offramp/build-payment'
import type { OfframpExpectation } from '../offramp/build-payment'
import type { AnchorTransaction } from '../offramp/sep24'
import { USDC } from '../swap/assets'

/**
 * The one transaction in this app that pays a third party, and the gate that
 * admits it. Each field the anchor names is checked on its own, so a refusal
 * says which one — and every refusal is tested by building the wrong
 * transaction directly rather than by asking the builder to misbehave.
 */

const ME = Keypair.random().publicKey()
const ANCHOR_ACCOUNT = Keypair.random().publicKey()
const HASH_B64 = Buffer.alloc(32, 5).toString('base64')
const NET = stellarTestnet.networkPassphrase
const USDC_ASSET = new Asset(USDC.code, USDC.issuer as string)

const READY: AnchorTransaction = {
  id: 'tx-1',
  kind: 'withdrawal',
  status: 'pending_user_transfer_start',
  withdrawAnchorAccount: ANCHOR_ACCOUNT,
  withdrawMemo: HASH_B64,
  withdrawMemoType: 'hash',
  amountIn: '5',
  amountInAsset: `stellar:USDC:${USDC.issuer as string}`,
}

const EXPECT: OfframpExpectation = expectationFrom(ANCHORS.testanchor, READY)

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
      destination: w.destination ?? ANCHOR_ACCOUNT,
      asset: w.asset ?? USDC_ASSET,
      amount: w.amount ?? '5',
      ...(w.opSource !== undefined ? { source: w.opSource } : {}),
    })
  )
  if (w.twoOps === true) {
    b.addOperation(
      Operation.payment({ destination: ANCHOR_ACCOUNT, asset: Asset.native(), amount: '1' })
    )
  }
  return b
    .addMemo(w.memo ?? Memo.hash(Buffer.from(HASH_B64, 'base64')))
    .setTimeout(180)
    .build()
    .toXDR()
}

describe('expectationFrom', () => {
  it('reads every field from a ready transaction', () => {
    expect(EXPECT).toEqual({
      anchorId: 'testanchor',
      transactionId: 'tx-1',
      destination: ANCHOR_ACCOUNT,
      memo: HASH_B64,
      memoType: 'hash',
      amount: '5',
      assetCode: 'USDC',
      assetIssuer: USDC.issuer,
    })
  })

  it('refuses a transaction that is not ready', () => {
    expect(() => expectationFrom(ANCHORS.testanchor, { ...READY, status: 'incomplete' })).toThrow(
      /not ready.*incomplete/
    )
  })

  it('refuses a ready transaction missing its destination', () => {
    const { withdrawAnchorAccount: _drop, ...noDest } = READY
    expect(() => expectationFrom(ANCHORS.testanchor, noDest)).toThrow(/destination/)
  })

  it('refuses a ready transaction missing its memo', () => {
    const { withdrawMemo: _drop, ...noMemo } = READY
    expect(() => expectationFrom(ANCHORS.testanchor, noMemo)).toThrow(/memo/)
  })

  it('refuses an amount that is not a number', () => {
    expect(() => expectationFrom(ANCHORS.testanchor, { ...READY, amountIn: 'null' })).toThrow(
      /not a number/
    )
  })

  it('refuses a destination that is not an account', () => {
    expect(() =>
      expectationFrom(ANCHORS.testanchor, { ...READY, withdrawAnchorAccount: 'not-a-key' })
    ).toThrow(/not an account/)
  })

  it('refuses an asset that is not the app USDC', () => {
    const other = {
      ...READY,
      amountInAsset: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    }
    expect(() => expectationFrom(ANCHORS.testanchor, other)).toThrow(/asset/)
  })

  it('accepts an anchor that names no asset, taking the app USDC', () => {
    const { amountInAsset: _drop, ...unnamed } = READY
    expect(expectationFrom(ANCHORS.testanchor, unnamed).assetIssuer).toBe(USDC.issuer)
  })
})

describe('buildOfframpPayment', () => {
  it('builds a payment the assertion accepts', async () => {
    const built = await buildOfframpPayment({
      account: ME,
      expectation: EXPECT,
      fetchImpl: horizon,
    })
    expect(() => assertOfframpPayment(built.xdr, ME, EXPECT)).not.toThrow()
    const tx = TransactionBuilder.fromXDR(built.xdr, NET)
    expect(tx.operations).toHaveLength(1)
    expect((tx as { memo: Memo }).memo.type).toBe('hash')
  })

  it('refuses an unfunded account', async () => {
    await expect(
      buildOfframpPayment({
        account: Keypair.random().publicKey(),
        expectation: EXPECT,
        fetchImpl: horizon,
      })
    ).rejects.toThrow(/not funded/)
  })
})

describe('assertOfframpPayment refuses', () => {
  const refuses = (label: string, xdr: string, pattern: RegExp): void => {
    it(label, () => {
      expect(() => assertOfframpPayment(xdr, ME, EXPECT)).toThrow(pattern)
    })
  }

  refuses('a transaction sourced by another account', payment({ source: ANCHOR_ACCOUNT }), /source/)
  refuses('a payment to any account but the anchor', payment({ destination: ME }), /destination/)
  refuses(
    'the wrong asset code',
    payment({ asset: new Asset('EURC', USDC.issuer as string) }),
    /asset/
  )
  refuses(
    'the right code from the wrong issuer',
    payment({ asset: new Asset('USDC', Keypair.random().publicKey()) }),
    /issuer/
  )
  refuses('native XLM', payment({ asset: Asset.native() }), /asset/)
  refuses('an amount other than the anchor named', payment({ amount: '5.0000001' }), /amount/)
  refuses('a larger amount', payment({ amount: '50' }), /amount/)
  refuses('no memo', payment({ memo: Memo.none() }), /memo/)
  refuses('the right memo bytes as the wrong type', payment({ memo: Memo.text('short') }), /memo/)
  refuses(
    'a hash memo with different bytes',
    payment({ memo: Memo.hash(Buffer.alloc(32, 6)) }),
    /memo/
  )
  refuses('two operations', payment({ twoOps: true }), /exactly one/)
  refuses('a per-operation source', payment({ opSource: ANCHOR_ACCOUNT }), /sourced/)

  it('a fee bump', () => {
    const inner = TransactionBuilder.fromXDR(payment(), NET)
    const bump = TransactionBuilder.buildFeeBumpTransaction(ME, '1000', inner as never, NET)
    expect(() => assertOfframpPayment(bump.toXDR(), ME, EXPECT)).toThrow(/fee.bump/)
  })

  it('a non-payment operation', () => {
    const xdr = new TransactionBuilder(new Account(ME, '100'), {
      fee: BASE_FEE,
      networkPassphrase: NET,
    })
      .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
      .addMemo(Memo.hash(Buffer.from(HASH_B64, 'base64')))
      .setTimeout(180)
      .build()
      .toXDR()
    expect(() => assertOfframpPayment(xdr, ME, EXPECT)).toThrow(/payment/)
  })
})

describe('assertOfframpPayment accepts', () => {
  it('an amount written with trailing zeros', () => {
    // '5' and '5.0000000' are the same stroops; the anchor may send either.
    expect(() => assertOfframpPayment(payment({ amount: '5.0000000' }), ME, EXPECT)).not.toThrow()
  })

  it('a text memo when the anchor asked for text', () => {
    const textExpect: OfframpExpectation = { ...EXPECT, memo: 'order-7', memoType: 'text' }
    expect(() =>
      assertOfframpPayment(payment({ memo: Memo.text('order-7') }), ME, textExpect)
    ).not.toThrow()
  })

  it('an id memo when the anchor asked for id', () => {
    const idExpect: OfframpExpectation = { ...EXPECT, memo: '4242', memoType: 'id' }
    expect(() =>
      assertOfframpPayment(payment({ memo: Memo.id('4242') }), ME, idExpect)
    ).not.toThrow()
  })
})
