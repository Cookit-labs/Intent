import { describe, expect, it } from 'vitest'

import { walletErrorMessage } from '../wallet/error-message'

/**
 * Wallets throw in three shapes: an Error, a plain string (the LOBSTR extension
 * throws its error text as is), and the wallet kit's `{ code, message }`. Only
 * the first was read, so every LOBSTR failure was shown as "could not sign".
 */
describe('walletErrorMessage', () => {
  it('reads an Error', () => {
    expect(walletErrorMessage(new Error('User declined'))).toBe('User declined')
  })

  it('reads a thrown string', () => {
    expect(walletErrorMessage('Transaction is not supported')).toBe('Transaction is not supported')
  })

  it("reads the wallet kit's { code, message }", () => {
    expect(walletErrorMessage({ code: -3, message: 'Please set the wallet first' })).toBe(
      'Please set the wallet first'
    )
  })

  it('reads an { error } object', () => {
    expect(walletErrorMessage({ error: 'Network mismatch' })).toBe('Network mismatch')
  })

  it('falls back when there is nothing to read', () => {
    expect(walletErrorMessage(undefined)).toBe('The wallet could not sign this.')
    expect(walletErrorMessage({ code: 1 })).toBe('The wallet could not sign this.')
    expect(walletErrorMessage('')).toBe('The wallet could not sign this.')
  })
})
