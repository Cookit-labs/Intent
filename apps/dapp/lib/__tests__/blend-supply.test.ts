import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { assertSelfSupply, buildBlendSupply } from '../lend/blend-client'
import { BLEND_POOL } from '../swap/contract-registry'

/**
 * Building a supply, and refusing one that credits somebody else.
 *
 * The interesting tests here are the recipient ones. A supply is four arguments
 * and a struct, and three of those arguments are addresses — so the failure
 * that matters is not a malformed call but a well-formed one pointed at the
 * wrong account. It looks exactly like a deposit right up until the position
 * belongs to a stranger.
 */

const ME = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const STRANGER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function fakeHorizon(sequence = '1'): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ sequence }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

function request(): xdr.ScVal {
  return nativeToScVal(
    { address: new Address(XLM_SAC), amount: BigInt(10_000_000), request_type: 0 },
    {
      type: {
        address: ['symbol', 'address'],
        amount: ['symbol', 'i128'],
        request_type: ['symbol', 'u32'],
      },
    }
  )
}

/** A supply built by hand, so each address can be pointed somewhere. */
function handBuilt(from: string, spender: string, to: string, source = ME): string {
  const op = new Contract(BLEND_POOL).call(
    'submit',
    new Address(from).toScVal(),
    new Address(spender).toScVal(),
    new Address(to).toScVal(),
    xdr.ScVal.scvVec([request()])
  )
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(180)
    .build()
    .toXDR()
}

describe('building a supply', () => {
  it('builds an unsigned supply crediting the signer', async () => {
    const built = await buildBlendSupply({
      account: ME,
      asset: XLM_SAC,
      amount: '10000000',
      fetchImpl: fakeHorizon(),
    })

    expect(built.recipient).toBe(ME)
    expect(built.amount).toBe('10000000')
    expect(() => assertSelfSupply(built.xdr, ME)).not.toThrow()
  })

  it('refuses a supply of nothing', async () => {
    // A zero supply is a fee for no position.
    await expect(
      buildBlendSupply({ account: ME, asset: XLM_SAC, amount: '0', fetchImpl: fakeHorizon() })
    ).rejects.toThrow(/positive amount/)
  })

  it('refuses a negative supply', async () => {
    await expect(
      buildBlendSupply({ account: ME, asset: XLM_SAC, amount: '-1', fetchImpl: fakeHorizon() })
    ).rejects.toThrow(/positive amount/)
  })

  it('says so when the account is not funded', async () => {
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(
      buildBlendSupply({ account: ME, asset: XLM_SAC, amount: '1', fetchImpl: notFound })
    ).rejects.toThrow(/not funded/)
  })
})

describe('a supply must credit the account that funds it', () => {
  it('accepts one where all three addresses are the signer', () => {
    expect(() => assertSelfSupply(handBuilt(ME, ME, ME), ME)).not.toThrow()
  })

  it('refuses one credited to somebody else', () => {
    // The attack this assertion exists for. Everything is well-formed; the
    // position simply ends up belonging to a stranger.
    expect(() => assertSelfSupply(handBuilt(ME, ME, STRANGER), ME)).toThrow(/as to/)
  })

  it('refuses one funded from somebody else', () => {
    expect(() => assertSelfSupply(handBuilt(STRANGER, ME, ME), ME)).toThrow(/as from/)
  })

  it('refuses one authorised by somebody else', () => {
    expect(() => assertSelfSupply(handBuilt(ME, STRANGER, ME), ME)).toThrow(/as spender/)
  })

  it('checks all three rather than stopping at the first', () => {
    // Two of three being right is not close enough: `to` alone decides who
    // holds the position.
    expect(() => assertSelfSupply(handBuilt(ME, ME, STRANGER), ME)).toThrow(
      /must credit the account that funds it/
    )
  })
})

describe('a supply is a lone contract call', () => {
  it('refuses a transaction sourced from another account', () => {
    expect(() => assertSelfSupply(handBuilt(ME, ME, ME, STRANGER), ME)).toThrow(
      /is not the account/
    )
  })

  it('refuses a classic operation', () => {
    const payment = new TransactionBuilder(new Account(ME, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(180)
      .build()
      .toXDR()
    expect(() => assertSelfSupply(payment, ME)).toThrow(/not a contract invocation/)
  })

  it('refuses a call to a different function on the pool', () => {
    // A pool that supplies also borrows. Only one of those is built here.
    const borrow = new Contract(BLEND_POOL).call(
      'borrow',
      new Address(ME).toScVal(),
      new Address(ME).toScVal(),
      new Address(ME).toScVal(),
      xdr.ScVal.scvVec([request()])
    )
    const built = new TransactionBuilder(new Account(ME, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(borrow)
      .setTimeout(180)
      .build()
      .toXDR()
    expect(() => assertSelfSupply(built, ME)).toThrow(/is not a supply/)
  })

  it('refuses a call with the wrong number of arguments', () => {
    const short = new Contract(BLEND_POOL).call('submit', new Address(ME).toScVal())
    const built = new TransactionBuilder(new Account(ME, '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(short)
      .setTimeout(180)
      .build()
      .toXDR()
    expect(() => assertSelfSupply(built, ME)).toThrow(/four arguments/)
  })
})
