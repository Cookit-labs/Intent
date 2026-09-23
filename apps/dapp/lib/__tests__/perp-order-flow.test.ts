import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import type { NoetherClient, PrepareOpenRequest } from '../perps/noether-client'
import { NoetherHttpError } from '../perps/noether-client'
import { prepareOrder, submitOrder, validateOrderRequest } from '../perps/order-flow'
import type { Simulate } from '../perps/simulate-order'

/**
 * The server's half of opening a position: what it asks the gateway for,
 * what it refuses, and what it hands the browser to review.
 *
 * The gateway builds the envelope; this app reads it back and compares it
 * with what the user typed before the browser ever sees it, then again on
 * the signed copy before it is forwarded. Both reads happen against contract
 * ids resolved from the gateway at that moment.
 */

const user = Keypair.random()
const ACCOUNT = user.publicKey()
const MARKET = 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN'
const ROUTER = 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG'

const REQUEST = {
  account: ACCOUNT,
  asset: 'XLM',
  side: 'long' as const,
  collateral: '50',
  leverage: 10,
}

function openEnvelope(
  t: {
    trader?: string
    asset?: string
    collateral?: string
    leverage?: number
    direction?: number
  } = {}
): string {
  return new TransactionBuilder(new Account(ACCOUNT, '100'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(MARKET).call(
        'open_position',
        new Address(t.trader ?? ACCOUNT).toScVal(),
        nativeToScVal(t.asset ?? 'XLM', { type: 'symbol' }),
        nativeToScVal(BigInt(t.collateral ?? '500000000'), { type: 'i128' }),
        nativeToScVal(t.leverage ?? 10, { type: 'u32' }),
        nativeToScVal(t.direction ?? 0, { type: 'u32' }),
        nativeToScVal(BigInt(0), { type: 'i128' })
      )
    )
    .setTimeout(300)
    .build()
    .toXDR()
}

function positionRetval(): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    id: nativeToScVal(BigInt(1), { type: 'u64' }),
    trader: new Address(ACCOUNT).toScVal(),
    asset: nativeToScVal('XLM', { type: 'symbol' }),
    collateral: nativeToScVal(BigInt('500000000'), { type: 'i128' }),
    size: nativeToScVal(BigInt('5000000000'), { type: 'i128' }),
    entry_price: nativeToScVal(BigInt('2132453'), { type: 'i128' }),
    direction: nativeToScVal(0, { type: 'u32' }),
    leverage: nativeToScVal(10, { type: 'u32' }),
    liquidation_price: nativeToScVal(BigInt('1972519'), { type: 'i128' }),
  }
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
    )
  )
}

const simulateOk: Simulate = async () => ({ ok: true, retval: positionRetval() })

function client(over: Partial<NoetherClient> = {}): NoetherClient {
  return {
    readHealth: async () => ({
      version: '0.0.0-dev',
      network: 'testnet',
      contracts: { market: MARKET, router: ROUTER, vault: 'CV', usdcToken: 'CU' },
      paused: false,
    }),
    readMarkets: async () => [
      {
        asset: 'XLM',
        name: 'Stellar Lumens',
        decimals: 7,
        markPrice: '2129103',
        markPriceUsd: 0.2129103,
        priceTimestamp: 1,
      },
    ],
    readStats: async () => [],
    readVaults: async () => [],
    betaStatus: async () => ({ gated: false, allowed: true }),
    requestChallenge: async () => ({ challengeHex: '', expiresAt: 0 }),
    exchangeChallenge: async () => ({ keyId: '', secret: '' }),
    prepareOpen: async () => ({ op: 'open_position', trader: ACCOUNT, xdr: openEnvelope() }),
    submit: async () => ({ hash: 'abc', status: 'SUCCESS', ledger: 1 }),
    ...over,
  }
}

describe('validateOrderRequest', () => {
  it('accepts a well-formed request and converts collateral to base units', () => {
    expect(validateOrderRequest({ ...REQUEST })).toEqual({
      ok: true,
      request: { ...REQUEST, collateralBase: '500000000' },
    })
  })

  it.each([
    [{ ...REQUEST, leverage: 11 }, /leverage/],
    [{ ...REQUEST, leverage: 0 }, /leverage/],
    [{ ...REQUEST, leverage: 2.5 }, /leverage/],
    [{ ...REQUEST, collateral: '0' }, /collateral/],
    [{ ...REQUEST, collateral: 'ten' }, /collateral/],
    [{ ...REQUEST, side: 'up' }, /side/],
    [{ ...REQUEST, account: 'not-a-key' }, /account/],
    [{ ...REQUEST, asset: '' }, /asset/],
  ])('refuses %j', (body, message) => {
    const out = validateOrderRequest(body)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(message)
  })
})

describe('prepareOrder', () => {
  it('asks the gateway for the order in base units and returns what to review', async () => {
    const asked: PrepareOpenRequest[] = []
    const out = await prepareOrder({
      client: client({
        prepareOpen: async (req) => {
          asked.push(req)
          return { op: 'open_position', trader: ACCOUNT, xdr: openEnvelope() }
        },
      }),
      simulate: simulateOk,
      token: 'nk_1:s3',
      request: { ...REQUEST, collateralBase: '500000000' },
    })
    expect(asked).toEqual([
      { token: 'nk_1:s3', asset: 'XLM', collateral: '500000000', leverage: 10, side: 'long' },
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.prepared).toEqual({
      xdr: openEnvelope(),
      contracts: { market: MARKET, router: ROUTER, vault: 'CV', usdcToken: 'CU' },
      version: '0.0.0-dev',
      markPrice: '2129103',
      markPriceUsd: 0.2129103,
      acceptablePrice: '0',
      position: {
        entryPrice: '2132453',
        liquidationPrice: '1972519',
        size: '5000000000',
        collateral: '500000000',
      },
    })
  })

  it('refuses an envelope that does not match the request', async () => {
    const out = await prepareOrder({
      client: client({
        prepareOpen: async () => ({
          op: 'open_position',
          trader: ACCOUNT,
          xdr: openEnvelope({ leverage: 5 }),
        }),
      }),
      simulate: simulateOk,
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
    })
    expect(out).toEqual({ ok: false, code: 'refused', error: expect.stringMatching(/leverage/) })
  })

  it('refuses a market the venue does not list', async () => {
    const out = await prepareOrder({
      client: client(),
      simulate: simulateOk,
      token: 't',
      request: { ...REQUEST, asset: 'DOGE', collateralBase: '500000000' },
    })
    expect(out).toEqual({ ok: false, code: 'unknown_market', error: expect.stringMatching(/DOGE/) })
  })

  it('refuses while the market is paused', async () => {
    const out = await prepareOrder({
      client: client({
        readHealth: async () => ({
          version: '0.0.0-dev',
          network: 'testnet',
          contracts: { market: MARKET, router: ROUTER, vault: 'CV', usdcToken: 'CU' },
          paused: true,
        }),
      }),
      simulate: simulateOk,
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
    })
    expect(out).toEqual({ ok: false, code: 'paused', error: expect.stringMatching(/paused/) })
  })

  it('refuses when the simulation fails, naming the reason', async () => {
    // The gateway simulated moments ago; a failure now is the oracle going
    // stale or the balance falling short, and a signature would only pay a
    // fee to learn that on-chain.
    const out = await prepareOrder({
      client: client(),
      simulate: async () => ({ ok: false, error: 'Error(Contract, #7)' }),
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
    })
    expect(out).toEqual({ ok: false, code: 'simulation', error: expect.stringMatching(/#7/) })
  })

  it('passes a gateway refusal through with its code', async () => {
    const out = await prepareOrder({
      client: client({
        prepareOpen: async () => {
          throw new NoetherHttpError(401, "Noether's gateway refused: bad key", 'invalid_bearer')
        },
      }),
      simulate: simulateOk,
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
    })
    expect(out).toEqual({
      ok: false,
      code: 'invalid_bearer',
      error: expect.stringMatching(/bad key/),
    })
  })
})

describe('submitOrder', () => {
  function signed(envelope: string): string {
    const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET)
    tx.sign(user)
    return tx.toXDR()
  }

  it('re-asserts the signed envelope, forwards it, and returns the hash', async () => {
    const forwarded: string[] = []
    const out = await submitOrder({
      client: client({
        submit: async ({ signedXdr }) => {
          forwarded.push(signedXdr)
          return { hash: 'abc', status: 'SUCCESS', ledger: 4828856 }
        },
      }),
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
      signedXdr: signed(openEnvelope()),
    })
    expect(out).toEqual({
      ok: true,
      hash: 'abc',
      ledger: 4828856,
      explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc',
    })
    expect(forwarded).toHaveLength(1)
  })

  it('refuses a signed envelope that no longer matches the request', async () => {
    const forwarded: string[] = []
    const out = await submitOrder({
      client: client({
        submit: async ({ signedXdr }) => {
          forwarded.push(signedXdr)
          return { hash: 'abc', status: 'SUCCESS' }
        },
      }),
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
      signedXdr: signed(openEnvelope({ direction: 1 })),
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/short/)
    expect(forwarded).toHaveLength(0)
  })

  it('reports an on-chain failure by its contract error name', async () => {
    const out = await submitOrder({
      client: client({
        submit: async () => ({
          hash: 'abc',
          status: 'FAILED',
          contractError: { code: 7, name: 'InsufficientCollateral' },
        }),
      }),
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
      signedXdr: signed(openEnvelope()),
    })
    expect(out).toEqual({
      ok: false,
      code: 'failed',
      hash: 'abc',
      error: expect.stringMatching(/InsufficientCollateral/),
    })
  })

  it('reports a submission still pending after the gateway stopped polling', async () => {
    const out = await submitOrder({
      client: client({ submit: async () => ({ hash: 'abc', status: 'PENDING' }) }),
      token: 't',
      request: { ...REQUEST, collateralBase: '500000000' },
      signedXdr: signed(openEnvelope()),
    })
    expect(out).toEqual({
      ok: false,
      code: 'pending',
      hash: 'abc',
      error: expect.stringMatching(/pending/i),
    })
  })
})
