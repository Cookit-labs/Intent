import { beforeEach, describe, expect, it, vi } from 'vitest'

import { assertNativeReserve, LIMIT_NOT_HERE, prepareChainAction } from '../chains/prepare'
import { ChainActionRefused, type ChainModule, type ChainVenue } from '../chains/types'

const SOL = { symbol: 'SOL', id: 'so11', decimals: 9 }
const USDC = { symbol: 'USDC', id: 'usdc', decimals: 6 }
const MON = { symbol: 'MON', id: 'mon', decimals: 18 }

const venuePrepare = vi.fn()
const priceUsd = vi.fn()
const balances = vi.fn()
const openOrders = vi.fn()
const prepareExit = vi.fn()

function venue(extra: Partial<ChainVenue> = {}): ChainVenue {
  return {
    id: 'book',
    name: 'Book',
    kinds: ['limit'],
    prepare: venuePrepare,
    assertSafe: () => undefined,
    ...extra,
  }
}

function module(over: Partial<ChainModule> = {}): ChainModule {
  return {
    chain: 'solana',
    tokens: [SOL, USDC],
    venues: [venue()],
    defaultVenue: { limit: 'book' },
    priceUsd,
    submit: vi.fn(),
    balances,
    ...over,
  }
}

const limit = (over: Record<string, string> = {}) => ({
  kind: 'limit' as const,
  amount: '1',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  limitPrice: '110',
  ...over,
})

let current: ChainModule | undefined
vi.mock('../chains/registry', () => ({
  chainModule: (chain: string) => (chain === 'solana' ? current : undefined),
}))

import { GET, POST } from '../../app/api/chain/[chain]/orders/route'

const ACCOUNT = '11111111111111111111111111111111'

beforeEach(() => {
  venuePrepare.mockReset()
  priceUsd.mockReset().mockResolvedValue(100)
  balances.mockReset().mockRejectedValue(new Error('no read'))
  openOrders.mockReset()
  prepareExit.mockReset()
  current = module()
})

describe('limit orders are checked before any venue is called', () => {
  it('refuses a chain with no trustworthy venue, in its own words', async () => {
    const mon = module({ chain: 'monad', tokens: [MON, USDC] })
    await expect(prepareChainAction(mon, limit({ tokenIn: 'MON' }), ACCOUNT)).rejects.toThrow(
      LIMIT_NOT_HERE.monad!
    )
    expect(LIMIT_NOT_HERE.monad).toMatch(/^Monad has no limit order venue I would trust/)
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('refuses a price that would fill at once', async () => {
    await expect(
      prepareChainAction(module(), limit({ limitPrice: '90' }), ACCOUNT)
    ).rejects.toThrow(/would sell below/)
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('refuses when there is no live price', async () => {
    for (const bad of [undefined, Number.NaN, 0]) {
      priceUsd.mockResolvedValue(bad)
      await expect(prepareChainAction(module(), limit(), ACCOUNT)).rejects.toThrow(
        "I have no live price for SOL, so I can't check that price. Nothing was signed or sent."
      )
    }
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('refuses a pair with no stablecoin', async () => {
    const m = module({ tokens: [SOL, USDC, { symbol: 'JUP', id: 'jup', decimals: 6 }] })
    await expect(prepareChainAction(m, limit({ tokenOut: 'JUP' }), ACCOUNT)).rejects.toThrow(
      'Limit orders here need USDC or USDT on one side. Nothing was signed or sent.'
    )
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('refuses when no venue does limit orders', async () => {
    const m = module({ venues: [], defaultVenue: {} })
    await expect(prepareChainAction(m, limit(), ACCOUNT)).rejects.toThrow(ChainActionRefused)
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('hands a good order to the venue', async () => {
    venuePrepare.mockResolvedValue({
      signing: { family: 'solana', transaction: 'x' },
    })
    await prepareChainAction(module(), limit(), ACCOUNT)
    expect(venuePrepare).toHaveBeenCalledTimes(1)
  })
})

describe('a limit order needs what it gives up in the wallet', () => {
  const row = (symbol: string, id: string, amount: string, native = false) => ({
    symbol,
    id,
    amount,
    decimals: id === 'so11' ? 9 : 6,
    native,
    listed: true,
  })
  const buy = limit({ amount: '2', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' })
  const built = { signing: { family: 'solana', transaction: 'x' } }

  it('refuses less than the order needs, before any venue is called', async () => {
    balances.mockResolvedValue({
      tokens: [row('SOL', 'so11', '5', true), row('USDC', 'usdc', '1.5')],
      complete: true,
    })
    await expect(prepareChainAction(module(), buy, ACCOUNT)).rejects.toThrow(
      'You hold 1.5 USDC, and this order needs 2. Nothing was signed or sent.'
    )
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('holds a sale of the native coin to the same check', async () => {
    balances.mockResolvedValue({ tokens: [row('SOL', 'so11', '0.5', true)], complete: true })
    await expect(prepareChainAction(module(), limit(), ACCOUNT)).rejects.toThrow(
      'You hold 0.5 SOL, and this order needs 1. Nothing was signed or sent.'
    )
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('matches on the token id, so a copied symbol counts for nothing', async () => {
    balances.mockResolvedValue({
      tokens: [row('SOL', 'so11', '5', true), row('USDC', 'not-usdc', '100')],
      complete: true,
    })
    await expect(prepareChainAction(module(), buy, ACCOUNT)).rejects.toThrow(
      'You hold 0 USDC, and this order needs 2. Nothing was signed or sent.'
    )
    expect(venuePrepare).not.toHaveBeenCalled()
  })

  it('passes exactly what the order needs', async () => {
    venuePrepare.mockResolvedValue(built)
    balances.mockResolvedValue({
      tokens: [row('SOL', 'so11', '5', true), row('USDC', 'usdc', '2')],
      complete: true,
    })
    await prepareChainAction(module(), buy, ACCOUNT)
    expect(venuePrepare).toHaveBeenCalledTimes(1)
  })

  it.each<[string, () => void]>([
    ['a read that fails', () => balances.mockRejectedValue(new Error('no read'))],
    [
      'a list that may be missing the token',
      () =>
        balances.mockResolvedValue({ tokens: [row('SOL', 'so11', '5', true)], complete: false }),
    ],
    [
      'a token that could not be read',
      () =>
        balances.mockResolvedValue({
          tokens: [row('SOL', 'so11', '5', true)],
          complete: true,
          unread: ['USDC'],
        }),
    ],
  ])('does not refuse on %s', async (_name, arrange) => {
    arrange()
    venuePrepare.mockResolvedValue(built)
    await prepareChainAction(module(), buy, ACCOUNT)
    expect(venuePrepare).toHaveBeenCalledTimes(1)
  })

  it('reads nothing for an order refused on its price', async () => {
    await expect(
      prepareChainAction(module(), limit({ limitPrice: '90' }), ACCOUNT)
    ).rejects.toThrow(/would sell below/)
    expect(balances).not.toHaveBeenCalled()
  })
})

describe('the native reserve counts a venue setup cost', () => {
  const held = {
    tokens: [
      { symbol: 'SOL', id: 'so11', amount: '0.0148', decimals: 9, native: true, listed: true },
    ],
    complete: true,
  }
  const costly = () =>
    module({ venues: [venue({ limitCost: { amount: '0.00684', symbol: 'SOL' } })] })

  it('refuses a limit that leaves too little for the cost, and names it', async () => {
    balances.mockResolvedValue(held)
    await expect(
      assertNativeReserve(costly(), limit({ amount: '0.005' }), ACCOUNT)
    ).rejects.toThrow(/0\.00684 SOL/)
  })

  it('does not add the cost to a request that is not a limit', async () => {
    balances.mockResolvedValue(held)
    const swap = { kind: 'swap' as const, amount: '0.005', tokenIn: 'SOL', tokenOut: 'USDC' }
    await expect(assertNativeReserve(costly(), swap, ACCOUNT)).resolves.toBeUndefined()
  })

  it('counts the cost when the token sold is not the native coin', async () => {
    balances.mockResolvedValue({
      ...held,
      tokens: [{ ...held.tokens[0]!, amount: '0.001' }],
    })
    const buy = limit({ amount: '100', tokenIn: 'USDC', tokenOut: 'SOL', limitPrice: '90' })
    await expect(assertNativeReserve(costly(), buy, ACCOUNT)).rejects.toThrow(/0\.00684 SOL/)
    await expect(assertNativeReserve(module(), buy, ACCOUNT)).resolves.toBeUndefined()
  })

  it('allows the same limit where the venue has no cost', async () => {
    balances.mockResolvedValue(held)
    await expect(
      assertNativeReserve(module(), limit({ amount: '0.005' }), ACCOUNT)
    ).resolves.toBeUndefined()
  })
})

const get = (chain: string, account = ACCOUNT) =>
  GET(new Request(`http://localhost/api/chain/${chain}/orders?account=${account}`), {
    params: Promise.resolve({ chain }),
  })

const post = (chain: string, body: unknown) =>
  POST(
    new Request(`http://localhost/api/chain/${chain}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ chain }) }
  )

describe('GET orders', () => {
  it('404s an unknown chain', async () => {
    expect((await get('dogecoin')).status).toBe(404)
  })

  it('answers an empty list from a module with no limit book', async () => {
    const res = await get('solana')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ orders: [] })
  })

  it('returns the book', async () => {
    openOrders.mockResolvedValue([{ id: '1' }])
    current = module({ limitBook: { openOrders, prepareExit } })
    await expect((await get('solana')).json()).resolves.toEqual({ orders: [{ id: '1' }] })
  })

  it('400s a refused account and 503s a failed read', async () => {
    current = module({ limitBook: { openOrders, prepareExit } })
    openOrders.mockRejectedValue(new ChainActionRefused('bad'))
    expect((await get('solana')).status).toBe(400)
    openOrders.mockRejectedValue(new Error('down'))
    const res = await get('solana')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'orders_unavailable' })
  })
})

describe('POST orders', () => {
  const body = { account: ACCOUNT, orderId: 'o1', action: 'cancel' }

  it('404s an unknown chain and 400s a bad account or action', async () => {
    expect((await post('dogecoin', body)).status).toBe(404)
    expect((await post('solana', { ...body, account: '0xnope' })).status).toBe(400)
    expect((await post('solana', { ...body, action: 'close' })).status).toBe(400)
  })

  it('422s a module with no limit book', async () => {
    const res = await post('solana', body)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('Nothing was signed or sent.')
  })

  it('prepares a cancel or a collect', async () => {
    current = module({ limitBook: { openOrders, prepareExit } })
    prepareExit.mockResolvedValue({
      venueId: 'book',
      signing: { family: 'solana', transaction: 'x' },
    })
    const res = await post('solana', { ...body, action: 'collect' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ prepared: { venueId: 'book' } })
    expect(prepareExit).toHaveBeenCalledWith(ACCOUNT, 'o1', 'collect')
  })

  it('runs the venue assertSafe on what an exit builds', async () => {
    const assertSafe = vi.fn()
    current = module({
      venues: [venue({ assertSafe })],
      limitBook: { openOrders, prepareExit },
    })
    prepareExit.mockResolvedValue({
      venueId: 'book',
      signing: { family: 'solana', transaction: 'x' },
      context: { a: 'b' },
    })
    expect((await post('solana', body)).status).toBe(200)
    expect(assertSafe).toHaveBeenCalledWith({ family: 'solana', transaction: 'x' }, ACCOUNT, {
      a: 'b',
    })
  })

  it('refuses an exit the venue finds unsafe, or from no known venue', async () => {
    const unsafe = () => {
      throw new ChainActionRefused('pays a third party. Nothing was signed or sent.')
    }
    current = module({
      venues: [venue({ assertSafe: unsafe })],
      limitBook: { openOrders, prepareExit },
    })
    prepareExit.mockResolvedValue({
      venueId: 'book',
      signing: { family: 'solana', transaction: 'x' },
    })
    expect((await post('solana', body)).status).toBe(422)
    prepareExit.mockResolvedValue({
      venueId: 'ghost',
      signing: { family: 'solana', transaction: 'x' },
    })
    expect((await post('solana', body)).status).toBe(422)
  })

  it('422s a refusal from the venue', async () => {
    current = module({ limitBook: { openOrders, prepareExit } })
    prepareExit.mockRejectedValue(
      new ChainActionRefused('Already filled. Nothing was signed or sent.')
    )
    const res = await post('solana', body)
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({
      error: 'Already filled. Nothing was signed or sent.',
    })
  })
})
