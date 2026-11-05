import { describe, expect, it } from 'vitest'

import { chainTitle } from '../chain-title'

describe('chainTitle', () => {
  it('is only the name on a mainnet', () => {
    expect(chainTitle('Sui', 'Sui mainnet')).toBe('Sui')
    expect(chainTitle('Stellar', 'Stellar mainnet')).toBe('Stellar')
    expect(chainTitle('NEAR', 'NEAR mainnet')).toBe('NEAR')
  })

  it('says so on a testnet, which must not pass for real money', () => {
    expect(chainTitle('Stellar', 'Stellar testnet')).toBe('Stellar testnet')
    expect(chainTitle('Arc', 'Arc testnet')).toBe('Arc testnet')
  })
})
