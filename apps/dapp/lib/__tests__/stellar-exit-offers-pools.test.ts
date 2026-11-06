import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  getLiquidityPoolId,
  LiquidityPoolAsset,
} from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertSelfPoolWithdraw, buildPoolExit } from '../swap/build-pool'
import { fetchOffer } from '../swap/offers'

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GCYQ3NXJHGD7P36OVKII6GKVLAENQ6ZETYOBAPZTI4R6ZWUU6QLHVVUX'
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function poolId(): string {
  const usdc = new Asset('USDC', ISSUER)
  const native = Asset.native()
  const [a, b] = Asset.compare(native, usdc) <= 0 ? [native, usdc] : [usdc, native]
  return Buffer.from(
    getLiquidityPoolId('constant_product', new LiquidityPoolAsset(a, b, 30))
  ).toString('hex')
}

function horizon(options: {
  shares?: string
  reserves?: { asset: string; amount: string }[]
  id?: string
}): typeof fetch {
  const id = options.id ?? poolId()
  return (async (url: string) => {
    if (String(url).includes('/liquidity_pools/')) {
      return new Response(
        JSON.stringify({
          id,
          fee_bp: 30,
          total_shares: '1000.0000000',
          total_trustlines: '2',
          reserves: options.reserves ?? [
            { asset: 'native', amount: '5000.0000000' },
            { asset: `USDC:${ISSUER}`, amount: '1000.0000000' },
          ],
        }),
        { status: 200 }
      )
    }
    return new Response(
      JSON.stringify({
        sequence: '1',
        balances:
          options.shares === undefined
            ? []
            : [
                {
                  asset_type: 'liquidity_pool_shares',
                  balance: options.shares,
                  liquidity_pool_id: id,
                },
              ],
      }),
      { status: 200 }
    )
  }) as unknown as typeof fetch
}

describe('taking a share out of a pool', () => {
  it('burns every share held, with floors at the share of the reserves less 1%', async () => {
    const built = await buildPoolExit({
      account: ME,
      poolId: poolId(),
      fetchImpl: horizon({ shares: '100.0000000' }),
    })
    expect(built.shares).toBe('100.0000000')
    // A tenth of the pool, less 1%.
    expect(built.floors).toEqual([
      { code: 'XLM', amount: '495.0000000' },
      { code: 'USDC', amount: '99.0000000' },
    ])
    expect(() => assertSelfPoolWithdraw(built.xdr, ME)).not.toThrow()

    const tx = new Transaction(built.xdr, Networks.TESTNET)
    expect(tx.source).toBe(ME)
    expect(tx.operations).toHaveLength(1)
    expect(tx.operations[0]).toMatchObject({
      type: 'liquidityPoolWithdraw',
      liquidityPoolId: poolId(),
      amount: '100.0000000',
      minAmountA: '495.0000000',
      minAmountB: '99.0000000',
    })
  })

  it('keeps each floor beside its own asset when Horizon lists them the other way round', async () => {
    const built = await buildPoolExit({
      account: ME,
      poolId: poolId(),
      fetchImpl: horizon({
        shares: '100.0000000',
        reserves: [
          { asset: `USDC:${ISSUER}`, amount: '1000.0000000' },
          { asset: 'native', amount: '5000.0000000' },
        ],
      }),
    })
    const op = new Transaction(built.xdr, Networks.TESTNET).operations[0]
    // Native sorts first, so its floor is A whichever order the reserves arrived in.
    expect(op).toMatchObject({ minAmountA: '495.0000000', minAmountB: '99.0000000' })
  })

  it('refuses an account that holds no share', async () => {
    await expect(
      buildPoolExit({ account: ME, poolId: poolId(), fetchImpl: horizon({}) })
    ).rejects.toThrow(/hold no shares.*Nothing was signed or sent/)
  })

  it('refuses when the reserves read are not this pool', async () => {
    const wrong = 'a'.repeat(64)
    await expect(
      buildPoolExit({
        account: ME,
        poolId: wrong,
        fetchImpl: horizon({ shares: '1.0000000', id: wrong }),
      })
    ).rejects.toThrow(/did not match/)
  })

  it('refuses at the envelope anything but a lone withdrawal', () => {
    const build = (op: ReturnType<typeof Operation.payment>, source = ME): string =>
      new TransactionBuilder(new Account(source, '1'), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .addMemo(Memo.text('x'))
        .setTimeout(60)
        .build()
        .toXDR()

    expect(() =>
      assertSelfPoolWithdraw(
        build(Operation.payment({ destination: STRANGER, asset: Asset.native(), amount: '1' })),
        ME
      )
    ).toThrow(/not a liquidity pool operation/)

    const deposit = build(
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId(),
        maxAmountA: '1',
        maxAmountB: '1',
        minPrice: '1',
        maxPrice: '1',
      })
    )
    expect(() => assertSelfPoolWithdraw(deposit, ME)).toThrow(/not a withdrawal/)

    const someoneElses = build(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: poolId(),
        amount: '1',
        minAmountA: '0',
        minAmountB: '0',
      }),
      STRANGER
    )
    expect(() => assertSelfPoolWithdraw(someoneElses, ME)).toThrow(/refusing to sign/)
  })
})

describe('withdrawing a resting order', () => {
  afterEach(() => {
    vi.doUnmock('../swap/offers')
    vi.resetModules()
  })

  const record = {
    id: '42',
    seller: ME,
    selling: { asset_type: 'native' },
    // Not on any token list, as an order placed from another wallet app can be.
    buying: { asset_type: 'credit_alphanum4', asset_code: 'ZZZ', asset_issuer: ISSUER },
    amount: '5.0000000',
    price: '2.0000000',
    last_modified_ledger: 1,
  }

  async function route(offer: unknown): Promise<(request: Request) => Promise<Response>> {
    vi.resetModules()
    vi.doMock('../swap/offers', () => ({ fetchOffer: vi.fn(async () => offer) }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sequence: '1' }), { status: 200 }))
    )
    return (await import('../../app/api/offers/build/route')).POST
  }

  const ask = (body: unknown): Request =>
    new Request('http://localhost/api/offers/build', {
      method: 'POST',
      body: JSON.stringify(body),
    })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('takes the assets from the ledger, so a token off the list can still be withdrawn', async () => {
    const POST = await route(record)
    const res = await POST(ask({ account: ME, amount: '0', offerId: '42' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as { xdr: string; cancelling: boolean }
    expect(body.cancelling).toBe(true)
    const op = new Transaction(body.xdr, Networks.TESTNET).operations[0]
    expect(op).toMatchObject({ type: 'manageSellOffer', amount: '0.0000000', offerId: '42' })
  }, 30_000)

  it('refuses an order that belongs to someone else', async () => {
    const POST = await route({ ...record, seller: STRANGER })
    const res = await POST(ask({ account: ME, amount: '0', offerId: '42' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { xdr?: string; detail: string }
    expect(body.xdr).toBeUndefined()
    expect(body.detail).toMatch(/another account.*Nothing was signed or sent/)
  }, 30_000)

  it('says when the order has already gone', async () => {
    const POST = await route(undefined)
    const res = await POST(ask({ account: ME, amount: '0', offerId: '42' }))
    expect(res.status).toBe(404)
  }, 30_000)
})

describe('reading one order', () => {
  it('treats a 404 as gone, and anything else unreadable as a failure', async () => {
    const answer = (status: number): typeof fetch =>
      (async () => new Response('{}', { status })) as unknown as typeof fetch

    await expect(fetchOffer('1', { fetchImpl: answer(404) })).resolves.toBeUndefined()
    await expect(fetchOffer('1', { fetchImpl: answer(500) })).rejects.toThrow(/Horizon 500/)
  })
})
