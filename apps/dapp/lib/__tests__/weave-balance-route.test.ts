import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  usdcBalance: vi.fn(),
  isAccount: vi.fn(),
  guard: { ok: true, email: 'wallet:a' } as unknown,
}))

vi.mock('../weave/guard', () => ({ guardCashout: () => state.guard }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))
vi.mock('../weave/deposit', () => ({
  depositChain: () => ({
    usdcDecimals: 6,
    isAccount: state.isAccount,
    usdcBalance: state.usdcBalance,
  }),
}))

import { GET } from '../../app/api/cashout/balance/route'

function get(query: string): Request {
  return new Request(`http://localhost/api/cashout/balance?${query}`)
}

beforeEach(() => {
  state.usdcBalance.mockReset()
  state.isAccount.mockReset().mockReturnValue(true)
})

describe('GET /api/cashout/balance', () => {
  it('answers in display units, exactly', async () => {
    state.usdcBalance.mockResolvedValue(BigInt(12345678))
    const res = await GET(get('chain=sui&account=0x1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ balance: '12.345678' })
  })

  it('answers zero and whole amounts plainly', async () => {
    state.usdcBalance.mockResolvedValueOnce(BigInt(0))
    expect(await (await GET(get('chain=sui&account=0x1'))).json()).toEqual({ balance: '0' })
    state.usdcBalance.mockResolvedValueOnce(BigInt(3000000))
    expect(await (await GET(get('chain=sui&account=0x1'))).json()).toEqual({ balance: '3' })
  })

  it('refuses an unknown chain and a bad account', async () => {
    expect((await GET(get('chain=monad&account=0x1'))).status).toBe(400)
    state.isAccount.mockReturnValue(false)
    expect((await GET(get('chain=sui&account=nope'))).status).toBe(400)
    expect(state.usdcBalance).not.toHaveBeenCalled()
  })

  it('says it could not read rather than answering zero', async () => {
    state.usdcBalance.mockRejectedValue(new Error('rpc down'))
    const res = await GET(get('chain=sui&account=0x1'))
    expect(res.status).toBe(503)
    expect((await res.json()).balance).toBeUndefined()
  })
})
