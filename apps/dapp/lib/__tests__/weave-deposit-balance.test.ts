import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  viewCall: vi.fn(),
  balanceOf: vi.fn(),
  getBalance: vi.fn(),
  venueFetch: vi.fn(),
}))

vi.mock('../chains/near/rpc', async (original) => ({
  ...(await original<typeof import('../chains/near/rpc')>()),
  viewCall: mocks.viewCall,
}))
vi.mock('../swap/delivered-balance', () => ({ balanceOf: mocks.balanceOf }))
vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({ core: { getBalance: mocks.getBalance } }),
}))
vi.mock('../chains/solana/http', async (original) => ({
  ...(await original<typeof import('../chains/solana/http')>()),
  venueFetch: mocks.venueFetch,
}))

import { USDC_NEAR } from '../chains/near/tokens'
import { createAvalancheDeposit, type AvalancheClient } from '../weave/deposit/avalanche'
import { nearDeposit } from '../weave/deposit/near'
import { solanaDeposit } from '../weave/deposit/solana'
import { stellarDeposit } from '../weave/deposit/stellar'
import { suiDeposit } from '../weave/deposit/sui'

const SOLANA_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usdcBalance', () => {
  it('reads NEAR from the USDC contract', async () => {
    mocks.viewCall.mockResolvedValue('2500000')
    expect(await nearDeposit.usdcBalance('alice.near')).toBe(BigInt(2500000))
    expect(mocks.viewCall).toHaveBeenCalledWith(USDC_NEAR, 'ft_balance_of', {
      account_id: 'alice.near',
    })
  })

  it('reads Stellar, and an account with no USDC holds none', async () => {
    mocks.balanceOf.mockResolvedValueOnce(BigInt(30000000))
    expect(await stellarDeposit.usdcBalance('GABC')).toBe(BigInt(30000000))
    mocks.balanceOf.mockResolvedValueOnce(undefined)
    expect(await stellarDeposit.usdcBalance('GABC')).toBe(BigInt(0))
  })

  it('reads Sui', async () => {
    mocks.getBalance.mockResolvedValue({ balance: { balance: '1234567' } })
    expect(await suiDeposit.usdcBalance('0x1')).toBe(BigInt(1234567))
  })

  it('reads Solana from the wallet’s USDC account, without an indexed call', async () => {
    mocks.venueFetch.mockResolvedValue({
      status: 200,
      body: {
        result: {
          value: { owner: 'x', data: { parsed: { info: { tokenAmount: { amount: '4200000' } } } } },
        },
      },
    })
    expect(await solanaDeposit.usdcBalance(SOLANA_WALLET)).toBe(BigInt(4200000))
    // The public RPC refuses getTokenAccountBalance without a personal token.
    const [, request] = mocks.venueFetch.mock.calls[0] as [string, { body: { method: string } }]
    expect(request.body.method).toBe('getAccountInfo')
  })

  it('reads a Solana wallet with no USDC account as holding none', async () => {
    mocks.venueFetch.mockResolvedValue({ status: 200, body: { result: { value: null } } })
    expect(await solanaDeposit.usdcBalance(SOLANA_WALLET)).toBe(BigInt(0))
  })

  it('does not read a Solana failure as an empty wallet', async () => {
    mocks.venueFetch.mockResolvedValue({ status: 200, body: { error: { message: 'busy' } } })
    await expect(solanaDeposit.usdcBalance(SOLANA_WALLET)).rejects.toThrow()
    mocks.venueFetch.mockResolvedValue({ status: 403, body: {} })
    await expect(solanaDeposit.usdcBalance(SOLANA_WALLET)).rejects.toThrow()
  })

  it('reads Avalanche', async () => {
    const usdcBalance = vi.fn(async () => BigInt(9000000))
    const deposit = createAvalancheDeposit(() => ({ usdcBalance }) as unknown as AvalancheClient)
    const account = '0x00000000000000000000000000000000000000aa'
    expect(await deposit.usdcBalance(account)).toBe(BigInt(9000000))
    expect(usdcBalance).toHaveBeenCalledWith(account)
  })
})
