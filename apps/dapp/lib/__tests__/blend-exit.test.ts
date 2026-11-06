import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertSelfBorrow,
  assertSelfCollateralWithdraw,
  assertSelfRepay,
  assertSelfWithdraw,
  buildBlendRepay,
  buildBlendWithdraw,
  buildBlendWithdrawEverywhere,
} from '../lend/blend-client'
import {
  findDebt,
  planRepayAll,
  planWithdraw,
  repayAllAmount,
  spendableXlm,
  worthOf,
} from '../lend/exit'
import { explainExitError } from '../lend/pool-errors'
import type { BlendBalance, BlendPositions } from '../lend/position'
import { blendReserveFor, blendSymbol, suppliableReserve } from '../lend/reserves'
import { blendPool } from '../swap/contract-registry'

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const OTHER_CONTRACT = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const MAX = '170141183460469231731687303715884105727'

function balance(symbol: string, amount: string, reserveIndex = 0): BlendBalance {
  return {
    assetId: `C${symbol}`,
    reserveIndex,
    symbol,
    tokens: amount,
    amount,
    display: (Number(amount) / 1e7).toFixed(7),
  }
}

function positions(partial: Partial<BlendPositions>): BlendPositions {
  return {
    supplied: [],
    collateral: [],
    borrowed: [],
    health: { collateralBase: 0, liabilityBase: 0, healthFactor: undefined, liquidatable: false },
    liquidationPrice: undefined,
    ...partial,
  }
}

const horizon = (async () =>
  new Response(JSON.stringify({ sequence: '1' }), { status: 200 })) as unknown as typeof fetch

function poolCall(options: {
  pool?: string
  fn?: string
  to?: string
  requestType?: number
  amount?: string
}): string {
  const request = nativeToScVal(
    {
      address: new Address(XLM),
      amount: BigInt(options.amount ?? '10000000'),
      request_type: options.requestType ?? 1,
    },
    {
      type: {
        address: ['symbol', 'address'],
        amount: ['symbol', 'i128'],
        request_type: ['symbol', 'u32'],
      },
    }
  )
  return new TransactionBuilder(new Account(ME, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(options.pool ?? blendPool()).call(
        options.fn ?? 'submit',
        new Address(ME).toScVal(),
        new Address(ME).toScVal(),
        new Address(options.to ?? ME).toScVal(),
        xdr.ScVal.scvVec([request])
      )
    )
    .setTimeout(60)
    .build()
    .toXDR()
}

afterEach(() => {
  vi.doUnmock('../lend/position')
  vi.resetModules()
})

describe('choosing where a withdrawal comes from', () => {
  it('takes from the plain supply when it covers the amount', () => {
    const plan = planWithdraw(
      positions({ supplied: [balance('XLM', '500000000')], collateral: [balance('XLM', '900')] }),
      { symbol: 'xlm', amount: '250000000' }
    )
    expect(plan).toMatchObject({ from: 'supply', amount: '250000000', symbol: 'XLM' })
  })

  it('takes from collateral when that is where the money is', () => {
    const plan = planWithdraw(positions({ collateral: [balance('USDC', '500000000')] }), {
      symbol: 'USDC',
      amount: '250000000',
    })
    expect(plan).toMatchObject({ from: 'collateral', amount: '250000000' })
  })

  it('empties both forms when all of an asset is asked for', () => {
    const plan = planWithdraw(
      positions({ supplied: [balance('XLM', '5')], collateral: [balance('XLM', '9')] }),
      { symbol: 'XLM' }
    )
    expect(plan).toMatchObject({ from: 'both' })
    expect('amount' in plan).toBe(false)
  })

  it('refuses in plain words when there is nothing there', () => {
    const plan = planWithdraw(positions({ supplied: [balance('USDC', '5')] }), { symbol: 'XLM' })
    expect(plan).toMatchObject({
      refusal: expect.stringMatching(/no XLM in Blend.*Nothing was signed or sent\.$/),
    })
  })

  it('refuses more than is held rather than quietly taking less', () => {
    const plan = planWithdraw(positions({ supplied: [balance('XLM', '100000000')] }), {
      symbol: 'XLM',
      amount: '250000000',
    })
    expect(plan).toMatchObject({ refusal: expect.stringMatching(/less than you asked/) })
  })

  it('says so when an amount is more than either form holds, though not more than both', () => {
    const plan = planWithdraw(
      positions({
        supplied: [balance('XLM', '100000000')],
        collateral: [balance('XLM', '100000000')],
      }),
      { symbol: 'XLM', amount: '150000000' }
    )
    expect(plan).toMatchObject({ refusal: expect.stringMatching(/one withdrawal takes from one/) })
  })

  it('holds a named form to that form', () => {
    const plan = planWithdraw(positions({ supplied: [balance('XLM', '5')] }), {
      symbol: 'XLM',
      from: 'collateral',
    })
    expect(plan).toMatchObject({ refusal: expect.stringMatching(/no XLM as collateral/) })
  })
})

describe('repaying', () => {
  it('finds the debt or says there is none', () => {
    const debt = balance('USDC', '100')
    expect(findDebt(positions({ borrowed: [debt] }), { symbol: 'usdc' })).toBe(debt)
    expect(findDebt(positions({}), { symbol: 'USDC' })).toMatchObject({
      refusal: expect.stringMatching(/owe no USDC.*Nothing was signed or sent\.$/),
    })
  })

  it('asks for a little over the debt, because interest grows until it settles', () => {
    expect(repayAllAmount(BigInt(1_000_000_000))).toBe(BigInt(1_000_100_100))
  })

  it('clears the debt when the wallet can cover the margin', () => {
    expect(planRepayAll(BigInt(1_000_000_000), BigInt(2_000_000_000), 'USDC')).toEqual({
      amount: '1000100100',
      covers: true,
    })
  })

  it('never asks for more than the wallet holds, because the pool takes it all up front', () => {
    expect(planRepayAll(BigInt(1_000_000_000), BigInt(400_000_000), 'USDC')).toEqual({
      amount: '400000000',
      covers: false,
    })
  })

  it('refuses when the wallet holds none of it', () => {
    expect(planRepayAll(BigInt(100), BigInt(0), 'USDC')).toMatchObject({
      refusal: expect.stringMatching(/no USDC free.*Nothing was signed or sent\.$/),
    })
  })

  it('has no sentinel: a repayment with no amount is refused', async () => {
    await expect(buildBlendRepay({ account: ME, asset: XLM, fetchImpl: horizon })).rejects.toThrow(
      /needs an amount/
    )
  })

  it('reads spendable XLM as the balance less the minimum, open orders and room for the fee', () => {
    expect(
      spendableXlm({
        balances: [
          { asset_type: 'native', balance: '10.0000000', selling_liabilities: '1.0000000' },
        ],
        subentry_count: 2,
      })
    ).toBe(BigInt(10 * 1e7) - BigInt(2 * 1e7) - BigInt(1e7) - BigInt(5_000_000))
    expect(spendableXlm({ balances: [{ asset_type: 'native', balance: '1.0000000' }] })).toBe(
      BigInt(0)
    )
  })
})

describe('what stays behind', () => {
  it('values this reserve only, not whichever comes first in the map', () => {
    const usdc = { ...balance('USDC', '200', 1), tokens: '100' }
    expect(worthOf(usdc, { '0': '999999', '1': '50' })).toBe('100')
    expect(worthOf(usdc, { '0': '999999' })).toBe('0')
    expect(worthOf(undefined, { '1': '50' })).toBe('0')
  })
})

describe('the envelope a withdrawal or repayment may carry', () => {
  it('accepts what the builders make, right amount and paying the signer', async () => {
    const whole = await buildBlendWithdraw({ account: ME, asset: XLM, fetchImpl: horizon })
    expect(whole.everything).toBe(true)
    expect(whole.amount).toBe(MAX)
    expect(whole.recipient).toBe(ME)
    expect(() => assertSelfWithdraw(whole.xdr, ME)).not.toThrow()

    const both = await buildBlendWithdrawEverywhere({ account: ME, asset: XLM, fetchImpl: horizon })
    expect(both.everything).toBe(true)
    expect(() => assertSelfWithdraw(both.xdr, ME)).not.toThrow()

    const repay = await buildBlendRepay({
      account: ME,
      asset: XLM,
      amount: '1000',
      fetchImpl: horizon,
    })
    expect(repay.amount).toBe('1000')
    expect(() => assertSelfRepay(repay.xdr, ME)).not.toThrow()
  })

  it('refuses paying anyone else', () => {
    expect(() => assertSelfWithdraw(poolCall({ to: STRANGER }), ME)).toThrow(/refusing to sign/)
    expect(() => assertSelfRepay(poolCall({ to: STRANGER, requestType: 5 }), ME)).toThrow(
      /refusing to sign/
    )
  })

  it('refuses a contract that is not the pool', () => {
    expect(() => assertSelfWithdraw(poolCall({ pool: OTHER_CONTRACT }), ME)).toThrow(
      /is not Blend's pool/
    )
  })

  it('refuses any other function', () => {
    expect(() => assertSelfWithdraw(poolCall({ fn: 'gulp' }), ME)).toThrow(/Only submit/)
  })

  it('refuses a request of another kind, so a borrow cannot pass as a withdrawal', () => {
    expect(() => assertSelfWithdraw(poolCall({ requestType: 4 }), ME)).toThrow(/something other/)
    expect(() => assertSelfRepay(poolCall({ requestType: 4 }), ME)).toThrow(/something other/)
    expect(() => assertSelfBorrow(poolCall({ requestType: 1 }), ME)).toThrow(/something other/)
    expect(() => assertSelfCollateralWithdraw(poolCall({ requestType: 1 }), ME)).toThrow(
      /something other/
    )
  })

  it('accepts a collateral request as a withdrawal, since it pays the wallet too', () => {
    expect(() => assertSelfWithdraw(poolCall({ requestType: 3 }), ME)).not.toThrow()
  })
})

describe('naming reserves', () => {
  it('finds a reserve by ticker, whatever the case', () => {
    expect(blendReserveFor('xlm', 'mainnet')).toBe(OTHER_CONTRACT)
    expect(blendReserveFor('USDC', 'mainnet')).toBe(
      'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
    )
    expect(blendReserveFor('DOGE', 'mainnet')).toBeUndefined()
  })

  it('shows an id it does not know rather than guessing a ticker', () => {
    expect(blendSymbol('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 'mainnet')).toBe(
      'USDC'
    )
    expect(blendSymbol('CAAAAAAAAAAAAAAAAAAAAAAAAAAZZZZ', 'mainnet')).toBe('CAAA…ZZZZ')
  })

  it('will not supply testnet USDC, which is not the token the pool lends', () => {
    expect(suppliableReserve('XLM')).toBe(XLM)
    expect(suppliableReserve('USDC')).toBeUndefined()
  })
})

describe('refusals on the way out', () => {
  it('tells someone taking back collateral to repay, not to post more', () => {
    expect(explainExitError('HostError: Error(Contract, #1205)', 'withdraw')).toMatch(
      /backing a loan.*Repay the loan first.*Nothing was signed or sent\.$/
    )
  })

  it('says the wallet is short rather than showing the token error', () => {
    expect(explainExitError('HostError: Error(Contract, #10)', 'repay')).toMatch(
      /does not hold enough.*Nothing was signed or sent\.$/
    )
  })

  it('reads "nothing to burn" on a debt it has just read as an amount too small', () => {
    expect(explainExitError('HostError: Error(Contract, #1219)', 'repay')).toMatch(/too small/)
  })

  it('keeps an unknown code raw rather than guessing', () => {
    const raw = 'HostError: Error(Contract, #9999)'
    expect(explainExitError(raw, 'withdraw')).toBe(raw)
  })
})

describe('the routes, when the position cannot be read', () => {
  async function routes(): Promise<{
    withdraw: (request: Request) => Promise<Response>
    repay: (request: Request) => Promise<Response>
  }> {
    vi.resetModules()
    vi.doMock('../lend/position', () => ({
      readBlendPositions: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }))
    const withdraw = await import('../../app/api/lend/withdraw/route')
    const repay = await import('../../app/api/lend/repay/route')
    return { withdraw: withdraw.POST, repay: repay.POST }
  }

  const ask = (body: unknown): Request =>
    new Request('http://localhost/api/lend/x', { method: 'POST', body: JSON.stringify(body) })

  it('builds nothing, and does not say the position is empty', async () => {
    const { withdraw, repay } = await routes()

    const out = await withdraw(ask({ account: ME, symbol: 'XLM' }))
    expect(out.status).toBe(502)
    const body = (await out.json()) as { xdr?: string; error?: string }
    expect(body.xdr).toBeUndefined()
    expect(body.error).toMatch(/Could not read.*Nothing was signed or sent\./)

    const back = await repay(ask({ account: ME, symbol: 'USDC' }))
    expect(back.status).toBe(502)
    expect(((await back.json()) as { xdr?: string }).xdr).toBeUndefined()
  }, 30_000)

  it('refuses an amount that is not a positive whole figure of base units', async () => {
    const { withdraw } = await routes()
    const out = await withdraw(ask({ account: ME, symbol: 'XLM', amount: '-5' }))
    expect(out.status).toBe(400)
  }, 30_000)
})
