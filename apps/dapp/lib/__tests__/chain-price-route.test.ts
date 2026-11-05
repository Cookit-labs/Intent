import { beforeEach, describe, expect, it, vi } from 'vitest'

const priceUsd = vi.fn()

vi.mock('../chains/registry', () => ({
  chainModule: (chain: string) =>
    chain === 'solana'
      ? {
          chain,
          tokens: [{ symbol: 'SOL', id: 'so11', decimals: 9 }],
          priceUsd,
        }
      : undefined,
}))

import { GET } from '../../app/api/chain/[chain]/price/route'

const ask = (chain: string, token: string) =>
  GET(new Request(`http://localhost/api/chain/${chain}/price?token=${token}`), {
    params: Promise.resolve({ chain }),
  })

describe('the chain price route', () => {
  beforeEach(() => {
    priceUsd.mockReset()
  })

  it('answers a listed token, in any case', async () => {
    priceUsd.mockResolvedValue(96.66)
    const res = await ask('solana', 'sol')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ priceUsd: 96.66, decimals: 9 })
  })

  it('reads no price for a token the chain does not list', async () => {
    const res = await ask('solana', 'JUNK')
    expect(res.status).toBe(404)
    expect(priceUsd).not.toHaveBeenCalled()
  })

  it('refuses a chain it has no module for', async () => {
    expect((await ask('dogecoin', 'SOL')).status).toBe(404)
  })

  it('says so when there is no price, rather than giving one', async () => {
    priceUsd.mockResolvedValue(undefined)
    expect((await ask('solana', 'SOL')).status).toBe(503)
    priceUsd.mockRejectedValue(new Error('down'))
    expect((await ask('solana', 'SOL')).status).toBe(503)
  })
})
