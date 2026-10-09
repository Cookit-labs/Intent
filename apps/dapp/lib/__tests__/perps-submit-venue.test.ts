import { afterEach, describe, expect, it, vi } from 'vitest'

import { submitOrder } from '../perps/order-flow'

/**
 * `prepareOrder` refuses a venue that is not on the network; submit must too.
 * Without it, a testnet-signed envelope with matching arguments is forwarded
 * to the testnet gateway from a mainnet deployment.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

function fakeClient() {
  return {
    readHealth: vi.fn().mockRejectedValue(new Error('gateway reached')),
    submit: vi.fn(),
  }
}

describe('submitting a perp order on a network Noether is not on', () => {
  it('refuses before the gateway is asked for anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const client = fakeClient()
    const result = await submitOrder({
      client: client as never,
      token: 't',
      request: {} as never,
      signedXdr: 'AAAA',
    })
    expect(result).toMatchObject({ ok: false, code: 'refused' })
    expect((result as { error: string }).error).toMatch(/not on mainnet/)
    expect(client.readHealth).not.toHaveBeenCalled()
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('still reaches the gateway on testnet', async () => {
    const client = fakeClient()
    await submitOrder({
      client: client as never,
      token: 't',
      request: {} as never,
      signedXdr: 'AAAA',
    })
    expect(client.readHealth).toHaveBeenCalledTimes(1)
  })
})
