import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChainVenue, VenuePosition } from '../chains/types'

const { limit, venues } = vi.hoisted(() => ({
  limit: vi.fn(async (): Promise<Response | undefined> => undefined),
  venues: { list: [] as unknown[] },
}))

vi.mock('../server/rate-limit', () => ({ enforceRateLimit: limit }))
vi.mock('../chains/registry', () => ({
  chainModule: (chain: string) =>
    ['solana', 'sui', 'near', 'avalanche', 'monad'].includes(chain)
      ? { chain, venues: venues.list }
      : undefined,
}))

const EVM = `0x${'a'.repeat(40)}`
const SUI = `0x${'a'.repeat(64)}`
const SOLANA = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'

const venue = (
  name: string,
  kinds: ChainVenue['kinds'],
  positions?: ChainVenue['positions']
): Pick<ChainVenue, 'id' | 'name' | 'kinds' | 'positions'> => ({
  id: name.toLowerCase(),
  name,
  kinds,
  positions,
})

const held = (over: Partial<VenuePosition> = {}): VenuePosition => ({
  slot: 'supplied',
  symbol: 'USDC',
  amount: '5',
  ...over,
})

async function get(chain: string, account?: string): Promise<Response> {
  const { GET } = await import('../../app/api/chain/[chain]/positions/route')
  const query = account === undefined ? '' : `?account=${encodeURIComponent(account)}`
  return GET(new Request(`http://localhost/api/chain/${chain}/positions${query}`), {
    params: Promise.resolve({ chain }),
  })
}

describe('the positions route', () => {
  beforeEach(() => {
    limit.mockClear()
    venues.list = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('consults the limiter first, as a read', async () => {
    limit.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    const res = await get('nowhere')
    expect(res.status).toBe(429)
    expect(limit).toHaveBeenCalledWith(expect.anything(), 'read')
  }, 60_000)

  it('is bounded to 20 seconds', async () => {
    const route = await import('../../app/api/chain/[chain]/positions/route')
    expect(route.maxDuration).toBe(20)
  })

  it('answers 404 for a chain it does not know', async () => {
    expect((await get('nowhere', EVM)).status).toBe(404)
  })

  it.each([
    ['solana', undefined],
    ['solana', EVM],
    ['solana', 'not an address'],
    ['sui', EVM],
    ['sui', SOLANA],
    ['near', 'NOT.valid!'],
    ['avalanche', SUI],
    ['monad', SOLANA],
    ['monad', `${EVM}a`],
  ])('refuses on %s the account %j, and reads nothing', async (chain, account) => {
    const read = vi.fn(async () => [held()])
    venues.list = [venue('Aave', ['supply'], read)]
    const res = await get(chain, account)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_account' })
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    ['solana', SOLANA],
    ['sui', SUI],
    ['near', 'alice.near'],
    ['avalanche', EVM],
    ['monad', EVM],
  ])('passes each venue the account on %s', async (chain, account) => {
    const read = vi.fn(async () => [])
    venues.list = [venue('Aave', ['supply'], read)]
    expect((await get(chain, account)).status).toBe(200)
    expect(read).toHaveBeenCalledWith(account)
  })

  it('returns what each venue holds, and says which could not be read', async () => {
    venues.list = [
      venue('Aave', ['supply', 'withdraw'], async () => [
        held(),
        held({ slot: 'borrowed', amount: '2' }),
      ]),
      venue('Morpho', ['supply', 'withdraw'], async () => {
        throw new Error('rpc down')
      }),
      venue('Euler', ['supply', 'withdraw'], async () => []),
    ]
    const res = await get('avalanche', EVM)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      venues: [
        {
          id: 'aave',
          name: 'Aave',
          kinds: ['supply', 'withdraw'],
          positions: [held(), held({ slot: 'borrowed', amount: '2' })],
        },
        { id: 'euler', name: 'Euler', kinds: ['supply', 'withdraw'], positions: [] },
      ],
      unread: [{ id: 'morpho', name: 'Morpho' }],
    })
  })

  it('counts a venue that can hold money but has no reader as unread, not empty', async () => {
    venues.list = [venue('Kamino', ['supply', 'withdraw'])]
    expect(await (await get('solana', SOLANA)).json()).toEqual({
      venues: [],
      unread: [{ id: 'kamino', name: 'Kamino' }],
    })
  })

  it('leaves out a venue that only swaps or sends', async () => {
    venues.list = [
      venue('Jupiter', ['swap']),
      venue('Wallet transfer', ['send']),
      venue('Requests', ['invoice', 'pay_invoice']),
    ]
    expect(await (await get('solana', SOLANA)).json()).toEqual({ venues: [], unread: [] })
  })

  it('still reads a venue that has a reader, whatever its kinds', async () => {
    venues.list = [venue('LST', ['swap'], async () => [held({ slot: 'staked' })])]
    const body = (await (await get('solana', SOLANA)).json()) as {
      venues: { positions: unknown[] }[]
    }
    expect(body.venues[0]?.positions).toEqual([held({ slot: 'staked' })])
  })

  it('drops zero figures', async () => {
    venues.list = [
      venue('Aave', ['supply'], async () => [
        held({ amount: '0' }),
        held({ amount: '0.0' }),
        held({ amount: '0.000001' }),
      ]),
    ]
    const body = (await (await get('avalanche', EVM)).json()) as {
      venues: { positions: VenuePosition[] }[]
    }
    expect(body.venues[0]?.positions.map((p) => p.amount)).toEqual(['0.000001'])
  })

  it('reads a venue whose figure is no number as unread, not empty', async () => {
    venues.list = [venue('Aave', ['supply'], async () => [held({ amount: 'NaN' })])]
    expect(await (await get('avalanche', EVM)).json()).toEqual({
      venues: [],
      unread: [{ id: 'aave', name: 'Aave' }],
    })
  })

  it('counts a venue that runs late as unread, and does not wait for it', async () => {
    // Loaded before the clock stops: importing the route takes real time.
    await import('../../app/api/chain/[chain]/positions/route')
    vi.useFakeTimers()
    venues.list = [
      venue('Slow', ['supply'], () => new Promise<VenuePosition[]>(() => undefined)),
      venue('Quick', ['supply'], async () => [held()]),
    ]
    const pending = get('avalanche', EVM)
    await vi.advanceTimersByTimeAsync(6001)
    const body = (await (await pending).json()) as {
      venues: { name: string }[]
      unread: { name: string }[]
    }
    expect(body.venues.map((v) => v.name)).toEqual(['Quick'])
    expect(body.unread.map((v) => v.name)).toEqual(['Slow'])
  })

  it('reports all of them unread when none can be read, and still answers', async () => {
    venues.list = [
      venue('A1', ['stake'], async () => {
        throw new Error('down')
      }),
      venue('B2', ['borrow'], () => {
        throw new Error('throws before it even starts')
      }),
    ]
    const res = await get('near', 'alice.near')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      venues: [],
      unread: [
        { id: 'a1', name: 'A1' },
        { id: 'b2', name: 'B2' },
      ],
    })
  })
})
