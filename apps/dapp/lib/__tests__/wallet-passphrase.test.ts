import { describe, expect, it } from 'vitest'

import { walletPassphrase } from '../wallet-network'

describe('walletPassphrase', () => {
  it("uses the wallet's own answer", async () => {
    expect(await walletPassphrase(async () => ({ networkPassphrase: 'WALLET' }), 'PAGE')).toBe(
      'WALLET'
    )
  })

  it('falls back to the page for a wallet that cannot report a network', async () => {
    const lobstr = (): Promise<{ networkPassphrase: string }> =>
      Promise.reject({ code: -3, message: 'Lobstr does not support the "getNetwork" function' })
    expect(await walletPassphrase(lobstr, 'PAGE')).toBe('PAGE')
  })

  it('falls back when the answer is empty', async () => {
    expect(await walletPassphrase(async () => ({ networkPassphrase: '' }), 'PAGE')).toBe('PAGE')
  })
})
