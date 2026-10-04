import { describe, expect, it } from 'vitest'

import { otherStellarNetwork } from '../other-stellar-network'

describe('otherStellarNetwork', () => {
  it('offers testnet from a mainnet deployment, and mainnet from a testnet one', () => {
    expect(otherStellarNetwork('mainnet', undefined, '/stellar/apps').label).toBe('Stellar testnet')
    expect(otherStellarNetwork('testnet', undefined, '/stellar/apps').label).toBe('Stellar mainnet')
  })

  it('has no link when the other deployment is not configured', () => {
    expect(otherStellarNetwork('mainnet', undefined, '/stellar/apps').href).toBeUndefined()
    expect(otherStellarNetwork('mainnet', '', '/stellar/apps').href).toBeUndefined()
  })

  it('keeps the user on the same screen of the other deployment', () => {
    expect(
      otherStellarNetwork('mainnet', 'https://testnet.example.com', '/stellar/apps').href
    ).toBe('https://testnet.example.com/stellar/apps')
    expect(
      otherStellarNetwork('mainnet', 'https://testnet.example.com/', '/stellar/apps').href
    ).toBe('https://testnet.example.com/stellar/apps')
  })

  it('refuses a configured address that is not http or https', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'testnet.example.com',
      '//evil.test',
    ]) {
      expect(otherStellarNetwork('mainnet', bad, '/stellar/apps').href, bad).toBeUndefined()
    }
  })
})
